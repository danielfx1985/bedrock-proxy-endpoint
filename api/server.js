// -------------------------------------------------
// -- import environment variables from .env file --
// -------------------------------------------------
import dotenv from 'dotenv';
dotenv.config();

// ------------------------------
// -- import utility functions --
// ------------------------------
import { toBoolean, extractAWSCreds } from "../utils.js";

const CONSOLE_LOGGING = toBoolean(process.env.CONSOLE_LOGGING);
const HTTP_ENABLED = toBoolean(process.env.HTTP_ENABLED);
const HTTP_PORT = process.env.HTTP_PORT;
const HTTPS_ENABLED = toBoolean(process.env.HTTPS_ENABLED);
const HTTPS_PORT = process.env.HTTPS_PORT;
const HTTPS_KEY_PATH = process.env.HTTPS_KEY_PATH;
const HTTPS_CERT_PATH = process.env.HTTPS_CERT_PATH;
const IP_RATE_LIMIT_ENABLED = toBoolean(process.env.IP_RATE_LIMIT_ENABLED);
const IP_RATE_LIMIT_WINDOW_MS = parseInt(process.env.IP_RATE_LIMIT_WINDOW_MS);
const IP_RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.IP_RATE_LIMIT_MAX_REQUESTS);

// --------------------------------------------
// -- import functions from bedrock-wrapper  --
// --     - bedrockWrapper                    --
// --     - listBedrockWrapperSupportedModels --
// --------------------------------------------
import {
    bedrockWrapper,
    listBedrockWrapperSupportedModels
} from "./local-modules/bedrock-wrapper/bedrock-wrapper.js";

console.log("    ============================ PROXY ENDPOINT =============================");
console.log("");

// -----------------------------------
// -- import server and its modules --
// -----------------------------------
import express from 'express';
import bodyParser from 'body-parser';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { stdout } from 'process';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(bodyParser.json());
// 启用 trust proxy
app.set('trust proxy', true);

// ------------------------------------
// -- setup rate limiting middleware --
// ------------------------------------
if (IP_RATE_LIMIT_ENABLED) {
    const limiter = rateLimit({
        windowMs: IP_RATE_LIMIT_WINDOW_MS,
        max: IP_RATE_LIMIT_MAX_REQUESTS
    });
    app.use(limiter);
}

// -------------------------------
// -- error handling middleware --
// -------------------------------
app.use((err, req, res, next) => {
    if (err.code === 'ECONNRESET') {
        console.warn('Connection reset by peer');
        res.status(500).send('Connection reset by peer');
    } else if (err.headersSent) {
        return next(err);
    } else {
        console.error(err.stack);
        res.status(500).send('Something broke!');
    }
});

// -------------------
// -- Info endpoint --
// -------------------
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// -------------------------------------
// -- Endpoint: list supported models --
// -------------------------------------
app.get('/models', (req, res) => {
    listBedrockWrapperSupportedModels().then(supportedModels => {
        res.json(supportedModels);
    }).catch(err => {
        console.error("Failed to fetch models:", err);
        res.status(500).send('Failed to fetch models');
    });
});

// --------------------------------------------------------
// -- Endpoint: infer AWS Bedrock Proxy Chat Completions --
// --------------------------------------------------------
app.post('/v1/chat/completions', async (req, res) => {
    const {
        messages = [],
        model = 'claude-3-5-sonnet',
        max_tokens = 800,
        temperature = 0.4,
        top_p = 0.9,
        stream = false
    } = req.body;

    try {
        // 验证消息数组
        if (!messages.length) {
            return res.status(400).json({
                error: {
                    message: "Messages array is empty",
                    type: "invalid_request_error",
                    code: 400
                }
            });
        }

        // 提取 AWS 凭证
        const bearerToken = req.headers.authorization?.replace('Bearer ', '');
        if (!bearerToken) {
            return res.status(401).json({
                error: {
                    message: "No authorization token provided",
                    type: "auth_error",
                    code: 401
                }
            });
        }

        const tokenParts = extractAWSCreds(bearerToken);
        if (tokenParts.error) {
            return res.status(401).json({
                error: {
                    message: tokenParts.message,
                    type: "auth_error",
                    code: 401
                }
            });
        }

        const { AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY } = tokenParts.credentials;

        // 创建 AWS 凭证对象
        const awsCreds = {
            region: AWS_REGION,
            accessKeyId: AWS_ACCESS_KEY_ID,
            secretAccessKey: AWS_SECRET_ACCESS_KEY
        };

        // 创建请求对象
        const bedrockParams = {
            messages,
            model,
            max_tokens,
            stream,
            temperature,
            top_p
        };

        // 设置超时
        const timeout = setTimeout(() => {
            res.status(504).json({ error: { message: "Request timed out", code: 504 } });
        }, 100000); // 10秒超时

        if (stream) {
            // 设置流式响应的头部
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            });

            // 流式响应
            for await (const chunk of bedrockWrapper(awsCreds, bedrockParams, { logging: CONSOLE_LOGGING })) {
                const streamResponse = {
                    id: `chatcmpl-${Date.now()}`,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: model,
                    choices: [{
                        index: 0,
                        delta: {
                            role: "assistant",
                            content: chunk
                        },
                        finish_reason: null
                    }]
                };
                
                res.write(`data: ${JSON.stringify(streamResponse)}\n\n`);
                if (CONSOLE_LOGGING) { stdout.write(chunk); }
            }

            // 发送结束消息
            res.write(`data: ${JSON.stringify({
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: "stop"
                }]
            })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        } else {
            // 非流式响应
            let completeResponse = '';
            const response = await bedrockWrapper(awsCreds, bedrockParams, { logging: CONSOLE_LOGGING });
            
            for await (const data of response) {
                completeResponse += data;
            }

            // 清除超时
            clearTimeout(timeout);

            // 设置 JSON 响应的头部
            res.setHeader('Content-Type', 'application/json');
            
            // 发送完整的响应
            res.json({
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: model,
                system_fingerprint: "fp_" + Date.now(),
                choices: [{
                    index: 0,
                    message: {
                        role: "assistant",
                        content: completeResponse
                    },
                    finish_reason: "stop"
                }],
                usage: {
                    prompt_tokens: messages.reduce((acc, msg) => acc + msg.content.length, 0),
                    completion_tokens: completeResponse.length,
                    total_tokens: messages.reduce((acc, msg) => acc + msg.content.length, 0) + completeResponse.length
                }
            });
        }
    } catch (error) {
        console.error("Error during request processing:", error);
        res.status(500).json({
            error: {
                message: "An error occurred during processing",
                type: "internal_server_error",
                code: 500
            }
        });
    }
});

// ----------------------
// -- start the server --
// ----------------------
if (HTTP_ENABLED) {
    // start the HTTP server
    const httpServer = http.createServer(app);
    httpServer.listen(HTTP_PORT, () => {
        console.log(`HTTP Server listening on port ${HTTP_PORT}`);
    });
}
if (HTTPS_ENABLED) {
    // start the HTTPS server
    const httpsServer = https.createServer({
        key: fs.readFileSync(HTTPS_KEY_PATH, 'utf-8'),
        cert: fs.readFileSync(HTTPS_CERT_PATH, 'utf-8')
    }, app);
    httpsServer.listen(HTTPS_PORT, () => {
        console.log(`HTTPS Server listening on port ${HTTPS_PORT}`);
    });
}