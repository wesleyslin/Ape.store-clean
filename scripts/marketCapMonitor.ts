import axios from 'axios';
import pino from 'pino';
import { config } from 'dotenv';
import https from 'https';

// Load environment variables from .env file
config();

const logger = pino({
    transport: {
        target: 'pino-pretty',
        options: { colorize: true }
    }
});

const API_URL = 'https://ape.store/api/tokens?page=0&sort=2&order=1&filter=0&search=&chain=0';
const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1248154493745500270/msmYbgf2ycxF1j2dNN9wN6PxM6HX0KWhvKwy04PLxu-xfQGd1AzlRbH5aCj7OhUa6vNF';

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

interface ApiResponse {
    items: TokenEntry[];
    pageCount: number;
}

let firstRun = true;
const notifiedTokens = new Map<string, Set<number>>();
const previousMarketCaps = new Map<string, number>();

async function fetchTokens(): Promise<ApiResponse> {
    try {
        const response = await proxyAxios.get(API_URL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': '*/*',
                'Content-Type': 'application/json'
            }
        });

        if (response.data && Array.isArray(response.data.items)) {
            if (firstRun) {
                logger.info('Tokens fetched successfully');
                firstRun = false;
            }
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

async function sendDiscordNotification(token: TokenEntry, threshold: number) {
    const websiteLink = `https://ape.store/base/${token.address}`;
    const explorerLink = `https://basescan.org/address/${token.address}`;

    const embed = {
        title: `🚀 Token Reached ${threshold} Market Cap: ${token.name}`,
        description: `**Market Cap:** $${token.marketCap.toLocaleString()}\n**View on Apestore:** [Link](${websiteLink})\n**Explorer:** [Link](${explorerLink})\n**Address:** [Link](${explorerLink})`,
        color: 0x00FF00, // Green color
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
        logger.info(`Notification sent successfully for token: ${token.name} at ${threshold} threshold`);
    } catch (error) {
        logger.error('Error sending Discord notification:', error);
    }
}

async function monitorTokens() {
    try {
        logger.info('Fetching tokens...');
        const response = await fetchTokens();
        const tokens = response.items;

        for (const token of tokens) {
            const previousMarketCap = previousMarketCaps.get(token.address) || 0;

            const tokenNotifiedThresholds = notifiedTokens.get(token.address) || new Set<number>();

            if (token.marketCap >= 60000 && (!tokenNotifiedThresholds.has(60000) || previousMarketCap < 60000)) {
                await sendDiscordNotification(token, 60000);
                tokenNotifiedThresholds.add(60000);
                notifiedTokens.set(token.address, tokenNotifiedThresholds);
            } else if (token.marketCap >= 50000 && (!tokenNotifiedThresholds.has(50000) || previousMarketCap < 50000)) {
                await sendDiscordNotification(token, 50000);
                tokenNotifiedThresholds.add(50000);
                notifiedTokens.set(token.address, tokenNotifiedThresholds);
            } else if (token.marketCap >= 30000 && (!tokenNotifiedThresholds.has(30000) || previousMarketCap < 30000)) {
                await sendDiscordNotification(token, 30000);
                tokenNotifiedThresholds.add(30000);
                notifiedTokens.set(token.address, tokenNotifiedThresholds);
            }

            previousMarketCaps.set(token.address, token.marketCap);
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
    // Run the monitorTokens function initially
    await monitorTokens();

    // Check for tokens at random intervals between 10 to 20 seconds
    setInterval(monitorTokens, getRandomInterval(15000, 45000));
}

startMonitoring();
