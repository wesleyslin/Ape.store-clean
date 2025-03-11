import axios from 'axios';
import pino from 'pino';
import { config } from 'dotenv';
import fs from 'fs/promises'; // Use the promise-based API for fs
import https from 'https';

// Load environment variables from .env file
config();

const logger = pino({
    transport: {
        target: 'pino-pretty',
        options: { colorize: true }
    }
});

const API_URL = 'https://ape.store/api/tokens?page=0&sort=1&order=1&filter=2&search=&chain=0';
const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1248389058728824902/97NTTrMQyjwRpJwuNpRKgPKAeqDBEgcm7THhemUh9DXgDCIqcJ7F4y95ifEpflh1x5wd';
const FREED_TOKENS_FILE = 'freed_tokens.json';

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
}

interface FreedToken {
    name: string;
    address: string;
}

interface ApiResponse {
    items: TokenEntry[];
    pageCount: number;
}

let firstRun = true;
const seenTokens = new Map<string, string>(); // Map to store address and name of seen tokens

async function fetchTokens(page: number = 0): Promise<ApiResponse> {
    try {
        const response = await proxyAxios.get(`${API_URL}&page=${page}`, {
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

async function fetchAllTokens(): Promise<TokenEntry[]> {
    const response = await fetchTokens(0);
    return response.items;
}

async function sendDiscordNotification(token: TokenEntry) {
    const websiteLink = `https://ape.store/base/${token.address}`;
    const explorerLink = `https://basescan.org/address/${token.address}`;

    const embed = {
        title: `🆓 New Token Freed: ${token.name}`,
        description: `\n**View on Apestore:** [Link](${websiteLink})\n**Explorer:** [Link](${explorerLink})\n**Address:** [Link](${explorerLink})`,
        color: 0xFFFF00,
        timestamp: new Date().toISOString(), // Discord requires ISO 8601 format
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
        logger.info(`Notification sent successfully for token: ${token.name}`);
    } catch (error) {
        logger.error('Error sending Discord notification:', error);
    }
}

async function loadFreedTokens() {
    try {
        const data = await fs.readFile(FREED_TOKENS_FILE, 'utf-8');
        const tokens = JSON.parse(data) as FreedToken[];
        tokens.forEach(token => seenTokens.set(token.address, token.name));
        logger.info('Freed tokens loaded successfully');
    } catch (error) {
        if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            logger.warn('Freed tokens file not found, starting with an empty list');
        } else {
            logger.error('Error loading freed tokens:', error);
        }
    }
}

async function saveFreedTokens() {
    try {
        const tokens = Array.from(seenTokens.entries()).map(([address, name]) => ({ address, name }));
        await fs.writeFile(FREED_TOKENS_FILE, JSON.stringify(tokens, null, 2));
        logger.info('Freed tokens saved successfully');
    } catch (error) {
        logger.error('Error saving freed tokens:', error);
    }
}

async function monitorTokens() {
    try {
        logger.info('Fetching tokens from the first page...');
        const tokens = await fetchAllTokens();

        if (firstRun) {
            // Add all tokens to seenTokens on the first run
            tokens.forEach(token => seenTokens.set(token.address, token.name));
            firstRun = false;
            await saveFreedTokens();
            return; // Skip notifications on the first run
        }

        for (const token of tokens) {
            if (!seenTokens.has(token.address)) {
                await sendDiscordNotification(token);
                seenTokens.set(token.address, token.name);
                await saveFreedTokens();
            }
        }
    } catch (error) {
        if (error instanceof Error) {
            logger.error('Error:', error.message);
        } else {
            logger.error('Unknown error:', error);
        }
    }
}

function getRandomInterval(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function startMonitoring() {
    // Load previously freed tokens
    await loadFreedTokens();

    // Run the monitorTokens function initially
    await monitorTokens();

    // Check for tokens at random intervals between 10 to 20 seconds
    setInterval(monitorTokens, getRandomInterval(10000, 20000));
}

startMonitoring();
