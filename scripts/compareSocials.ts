import axios from 'axios';
import pino from 'pino';
import { config } from 'dotenv';
import fs from 'fs/promises';
import https from 'https';

config();

const logger = pino({
    transport: {
        target: 'pino-pretty',
        options: { colorize: true }
    }
});

const API_URL = process.env.API_URL!;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL!;
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
    items: TokenEntry[];
    pageCount: number;
}

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
        console.log(error)
        logger.error('Error fetching tokens:', error);
        return { items: [], pageCount: 0 };
    }
}

function normalizeUrl(url: string | null): string {
    if (!url) return '';
    // Remove protocol, www, trailing slashes, and convert to lowercase
    let normalized = url.replace(/^(https?:\/\/)?(www\.)?/i, '').toLowerCase().replace(/\/$/, '');
    // Remove trailing dots and slashes
    normalized = normalized.replace(/[./]+$/, '');
    // If the URL is just a domain placeholder, return an empty string
    if (['x.com', 't.me', ''].includes(normalized)) return '';
    return normalized;
}

async function sendChangeNotification(token: TokenEntry, changes: string[]) {
    const projectLink = `https://ape.store/base/${token.address}`;
    
    // Create a title that specifies what was changed
    const changedFields = changes.map(change => change.split(' ')[0]).join(', ');
    const title = `🔄 ${changedFields} Change Detected - ${token.name}`;
    
    const embed = {
        title: title,
        description: `Changes detected for [$${token.name}](${projectLink})`,
        color: 0xFFFF00, // Yellow color
        timestamp: new Date().toISOString(),
        fields: changes.map(change => ({ name: change, value: '\u200B', inline: false }))
    };

    const payload = { embeds: [embed] };

    try {
        const response = await proxyAxios.post(DISCORD_WEBHOOK_URL, payload, {
            headers: { 'Content-Type': 'application/json' }
        });
        if (response.status !== 200 && response.status !== 204) {
            throw new Error(`Error status: ${response.status}`);
        }
        logger.info('Change notification sent successfully for token:', token.name);
    } catch (error) {
        logger.error('Error sending change notification:', error);
    }
}

async function checkForChanges() {
    logger.info('Checking for token information changes...');

    try {
        let existingTokens: TokenEntry[] = JSON.parse(await fs.readFile(EXISTING_TOKENS_FILE, 'utf-8'));
        let changesDetected = false;

        for (let page = 0; page < 10; page++) {
            const response = await fetchTokens(page);
            for (const apiToken of response.items) {
                const existingToken = existingTokens.find(t => t.address === apiToken.address);
                if (existingToken) {
                    const changes: string[] = [];
                    let tokenUpdated = false;

                    (['twitter', 'telegram', 'website'] as const).forEach((field) => {
                        const oldValue = normalizeUrl(existingToken[field]);
                        const newValue = normalizeUrl(apiToken[field]);

                        if (oldValue !== newValue) {
                            tokenUpdated = true;
                            existingToken[field] = apiToken[field]; // Keep the original format in storage

                            if (oldValue && newValue) {
                                changes.push(`${field.charAt(0).toUpperCase() + field.slice(1)} changed: ${existingToken[field]} -> ${apiToken[field]}`);
                            } else if (!oldValue && newValue) {
                                changes.push(`${field.charAt(0).toUpperCase() + field.slice(1)} added: ${apiToken[field]}`);
                            }
                            // If the new value is empty (removed), we don't add it to changes, but we still update the token
                        }
                    });

                    if (tokenUpdated) {
                        changesDetected = true;
                        if (changes.length > 0) {
                            logger.info(`Changes detected for token: ${apiToken.name}`);
                            await sendChangeNotification(apiToken, changes);
                        } else {
                            logger.info(`Social media removed for token: ${apiToken.name} (not notifying)`);
                        }
                    }
                }
            }
        }

        if (changesDetected) {
            await fs.writeFile(EXISTING_TOKENS_FILE, JSON.stringify(existingTokens, null, 2));
            logger.info('Updated tokens saved to tokens.json');
        } else {
            logger.info('No changes detected');
        }
    } catch (error) {
        logger.error('Error checking for changes:', error);
    }
}

async function main() {
    try {
        logger.info('Token comparison script started');
        await checkForChanges();

        while (true) {
            await new Promise(resolve => setTimeout(resolve, 10000 + Math.random() * 10000)); // Random delay between 5 and 10 seconds
            await checkForChanges();
        }
    } catch (error) {
        logger.error('Error in main function:', error);
    }
}

main().catch(error => {
    logger.error('Unhandled error in script:', error);
    process.exit(1);
});

process.on('SIGINT', () => {
    logger.info('Script terminated');
    process.exit();
});