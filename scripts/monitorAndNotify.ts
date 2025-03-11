import axios from 'axios';
import pino from 'pino';
import { config } from 'dotenv';
import fs from 'fs/promises';
import https from 'https';

// Load environment variables from .env file
config();

const logger = pino({
    transport: {
        target: 'pino-pretty',
        options: { colorize: true }
    }
});

const API_URL = process.env.API_URL!;
const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1248153256501448785/ky3XDsfWYXA8XMKNOkkZRZgwOlrVNC6WytR4g2RjanDG19WrSUyH2LoCrN7jjoOIqL0O';
const EXISTING_TOKENS_FILE = 'tokens.json';

const proxyAxios = axios.create({
    proxy: {
        host: 'brd.superproxy.io',
        port: 22225,
        auth: {
            username: 'brd-customer-hl_e38d6b71-zone-datacenter_proxy1',
            password: 'egl7cyh2lqp9'
        }
    },
    httpsAgent: new https.Agent({
        rejectUnauthorized: false
    })
});

interface TokenEntry {
    name: string;
    twitter: string | null;
    telegram: string | null;
    website: string | null;
    createDate: string | null;
    address: string;
    marketCap: number;
    creator: string;
}

interface ApiResponse {
    items: {
        name: string;
        symbol: string;
        twitter: string | null;
        telegram: string | null;
        website: string | null;
        createDate: string | null;
        address: string;
        marketCap: number;
        creator: string;
    }[];
    pageCount: number;
}

let existingTokens: TokenEntry[] = [];
const seenTokenAddresses = new Set<string>();
const notifiedTokens = new Set<string>();

async function fetchTokens(page: number): Promise<ApiResponse> {
    try {
        const response = await proxyAxios.get(`${API_URL}?page=${page}&sort=0&order=1&filter=0&search=&chain=0`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': '*/*',
                'Content-Type': 'application/json'
            }
        });

        if (response.data && Array.isArray(response.data.items)) {
            return response.data as ApiResponse;
        } else {
            logger.error('Unexpected response structure:', response.data);
            return { items: [], pageCount: 0 };
        }
    } catch (error) {
        logger.error('Error fetching tokens:', error);
        return { items: [], pageCount: 0 };
    }
}

function addHttps(url: string | null): string {
    if (!url) return '';
    if (!url.startsWith('http')) {
        return `https://${url}`;
    }
    return url;
}

function normalizeUrlForComparison(url: string | null): string | null {
    if (!url) return null;
    return url.replace(/^(?:https?:\/\/)?(?:www\.)?/i, "").toLowerCase().replace(/\/$/, "");
}

function normalizeSocialMediaLinksForComparison(token: TokenEntry): TokenEntry {
    return {
        ...token,
        twitter: normalizeUrlForComparison(token.twitter),
        telegram: normalizeUrlForComparison(token.telegram),
        website: normalizeUrlForComparison(token.website)
    };
}

function areTokensSimilar(newToken: TokenEntry, existingToken: TokenEntry): boolean {
    const nameMatch = newToken.name === existingToken.name;

    const twitterMatch = newToken.twitter && existingToken.twitter && normalizeUrlForComparison(newToken.twitter) === normalizeUrlForComparison(existingToken.twitter);
    const telegramMatch = newToken.telegram && existingToken.telegram && normalizeUrlForComparison(newToken.telegram) === normalizeUrlForComparison(existingToken.telegram);
    const websiteMatch = newToken.website && existingToken.website && normalizeUrlForComparison(newToken.website) === normalizeUrlForComparison(existingToken.website);

    return nameMatch || Boolean(twitterMatch) || Boolean(telegramMatch) || Boolean(websiteMatch);
}

async function checkForNewLaunches(existingTokens: TokenEntry[], seenTokenAddresses: Set<string>, notifiedTokens: Set<string>) {
    logger.info('Checking for new token launches...');
    const initialResponse = await fetchTokens(0);
    let tokens: TokenEntry[] = initialResponse.items;

    logger.info(`Total tokens fetched from first page: ${tokens.length}`);

    let newTokensAdded = false;

    for (const token of tokens) {
        if (!seenTokenAddresses.has(token.address)) {
            seenTokenAddresses.add(token.address);
            logger.info(`New token found: ${token.name}`);

            // Compare with existing tokens for red flags
            for (const existingToken of existingTokens) {
                if (!notifiedTokens.has(token.address) && areTokensSimilar(token, normalizeSocialMediaLinksForComparison(existingToken))) {
                    logger.info(`Red flag detected for token: ${token.name}`);
                    logger.info(`Match found with existing token: ${existingToken.name}`);
                    await sendRedFlagNotification(token, existingToken);
                    notifiedTokens.add(token.address); // Mark as notified
                    break; // Stop checking other existing tokens after a match is found
                }
            }

            // Add token to existing tokens, regardless of createDate
            const simplifiedToken = {
                name: token.name,
                twitter: token.twitter,
                telegram: token.telegram,
                website: token.website,
                createDate: token.createDate,
                address: token.address,
                marketCap: token.marketCap,
                creator: token.creator
            };
            existingTokens.push(simplifiedToken);
            newTokensAdded = true;
        }
    }

    // Save the updated tokens to the JSON file if new tokens were added
    if (newTokensAdded) {
        await saveTokensImmediately();
        logger.info('Updated tokens saved to tokens.json');
    } else {
        logger.info('No new tokens found, tokens.json not updated');
    }
}

async function sendRedFlagNotification(token: TokenEntry, match: TokenEntry) {
    const embed = {
        title: `🚨 Red Flag: New Project Launch Alert - ${token.name}`,
        description: `A new project with matching details has been launched.`,
        color: 0xFF0000, // Red color
        timestamp: new Date().toISOString(), // Discord requires ISO 8601 format
        fields: [
            { name: 'New Token', value: `**Name:** ${token.name}\n**Twitter:** ${token.twitter ? `[${token.twitter}](${token.twitter})` : 'N/A'}\n**Telegram:** ${token.telegram ? `[${token.telegram}](${token.telegram})` : 'N/A'}\n**Website:** ${token.website ? `[${token.website}](${token.website})` : 'N/A'}`, inline: true },
            { name: 'Existing Token', value: `**Name:** ${match.name}\n**Twitter:** ${match.twitter ? `[${match.twitter}](${match.twitter})` : 'N/A'}\n**Telegram:** ${match.telegram ? `[${match.telegram}](${match.telegram})` : 'N/A'}\n**Website:** ${match.website ? `[${match.website}](${match.website})` : 'N/A'}`, inline: true }
        ]
    };

    const payload = {
        embeds: [embed]
    };

    try {
        const response = await proxyAxios.post(DISCORD_WEBHOOK_URL, payload, {
            headers: {
                'Content-Type': 'application/json'
            }
        });
        if (response.status !== 200 && response.status !== 204) {
            throw new Error(`Error status: ${response.status}`);
        }
        logger.info('Red flag notification sent successfully for token:', token.name);
    } catch (error) {
        logger.error('Error sending red flag notification:', error);
    }
}

async function saveTokensImmediately() {
    // Load the existing tokens from the JSON file to ensure we don't overwrite any new additions
    let currentTokens: TokenEntry[] = [];
    if (await fs.stat(EXISTING_TOKENS_FILE).catch(() => false)) {
        currentTokens = JSON.parse(await fs.readFile(EXISTING_TOKENS_FILE, 'utf-8')).map(normalizeSocialMediaLinksForComparison);
    }

    // Combine the tokens to avoid overwriting
    const combinedTokens = [...currentTokens, ...existingTokens];
    // Remove duplicates
    const uniqueTokens = Array.from(new Set(combinedTokens.map(token => token.address)))
        .map(address => combinedTokens.find(token => token.address === address)!);
    await fs.writeFile(EXISTING_TOKENS_FILE, JSON.stringify(uniqueTokens, null, 2));
    logger.info('Tokens saved to tokens.json immediately');
}

async function saveTokensOnExit() {
    logger.info('Saving tokens on exit...');
    await saveTokensImmediately();
}

async function main() {
    try {
        // Read the existing tokens from the JSON file
        if (await fs.stat(EXISTING_TOKENS_FILE).catch(() => false)) {
            existingTokens = JSON.parse(await fs.readFile(EXISTING_TOKENS_FILE, 'utf-8')).map(normalizeSocialMediaLinksForComparison);
        }

        // Set up a set to store seen token addresses
        const seenTokenAddresses = new Set(existingTokens.map(token => token.address));
        const notifiedTokens = new Set<string>(); // Track notified tokens

        // Perform an initial check for new launches
        await checkForNewLaunches(existingTokens, seenTokenAddresses, notifiedTokens);

        // Save the latest tokens after the initial check to avoid overwriting
        await saveTokensImmediately();

        // Function to set a random interval for the next check
        const setRandomInterval = async () => {
            const interval = Math.floor(Math.random() * 10000) + 20000; // Random interval between 30000 and 60000 ms
            setTimeout(async () => {
                await checkForNewLaunches(existingTokens, seenTokenAddresses, notifiedTokens);
                await saveTokensImmediately(); // Save after each check to ensure updates are saved
                setRandomInterval(); // Set the next interval
            }, interval);
        };

        // Start the random interval checks
        setRandomInterval();

        // Save tokens on script exit
        process.on('exit', saveTokensOnExit);
        process.on('SIGINT', () => {
            saveTokensOnExit();
            process.exit();
        });
        process.on('SIGTERM', saveTokensOnExit);
    } catch (error) {
        if (error instanceof Error) {
            logger.error('Error:', error.message);
        } else {
            logger.error('Unknown error:', error);
        }
    }
}

main();
