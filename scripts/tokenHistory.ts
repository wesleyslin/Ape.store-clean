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

const API_URL = 'https://ape.store/api/tokens';

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
    creator: string | null; // Changed to string | null
}

interface ApiResponse {
    items: TokenEntry[];
    pageCount: number;
}

async function fetchTokens(page: number): Promise<ApiResponse> {
    try {
        logger.info(`Fetching tokens from page ${page}...`);
        const response = await proxyAxios.get(`${API_URL}?page=${page}&sort=1&order=1&filter=0&search=&chain=0`, {
            headers: {
                'Accept': '*/*',
                'Content-Type': 'application/json'
            }
        });

        if (response.data && Array.isArray(response.data.items)) {
            logger.info(`Fetched ${response.data.items.length} tokens from page ${page}`);
            return response.data as ApiResponse;
        } else {
            logger.warn('Unexpected response structure:', response.data);
            return { items: [], pageCount: 0 };
        }
    } catch (error) {
        logger.error('Error fetching tokens:', error);
        return { items: [], pageCount: 0 };
    }
}

async function loadExistingTokens(filePath: string): Promise<TokenEntry[]> {
    try {
        const data = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        logger.error('Error loading existing tokens:', error);
        return [];
    }
}

async function saveTokensToFile(tokens: TokenEntry[], filePath: string) {
    try {
        await fs.writeFile(filePath, JSON.stringify(tokens, null, 2));
        logger.info(`Tokens have been written to ${filePath}`);
    } catch (error) {
        logger.error('Error saving tokens:', error);
    }
}

function mergeTokens(existingTokens: TokenEntry[], fetchedTokens: TokenEntry[]): TokenEntry[] {
    const tokenMap = new Map<string, TokenEntry>();

    existingTokens.forEach(token => {
        tokenMap.set(token.address, token);
    });

    fetchedTokens.forEach(token => {
        if (tokenMap.has(token.address)) {
            const existingToken = tokenMap.get(token.address)!;
            if (!existingToken.creator) {
                existingToken.creator = token.creator;
            }
        } else {
            tokenMap.set(token.address, token);
        }
    });

    return Array.from(tokenMap.values());
}

async function main() {
    const filePath = 'tokens.json';
    try {
        logger.info('Loading existing tokens...');
        const existingTokens = await loadExistingTokens(filePath);

        logger.info('Fetching the first page to determine the total number of pages...');
        const initialResponse = await fetchTokens(0);
        const totalPages = initialResponse.pageCount;

        logger.info(`Total number of pages: ${totalPages}`);

        let fetchedTokens = initialResponse.items;

        // Fetch tokens from all pages
        for (let page = 1; page < totalPages; page++) {
            const response = await fetchTokens(page);
            if (response.items.length === 0) {
                break; // Stop if the response has no items
            }
            fetchedTokens = fetchedTokens.concat(response.items);
        }

        const updatedTokens = mergeTokens(existingTokens, fetchedTokens);
        await saveTokensToFile(updatedTokens, filePath);
    } catch (error) {
        if (error instanceof Error) {
            logger.error('Error:', error.message);
        } else {
            logger.error('Unknown error:', error);
        }
    }
}

main();
