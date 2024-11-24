import express from 'express';
import bodyParser from 'body-parser';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { stdout } from 'process';
import { toBoolean, extractAWSCreds } from "../utils.js";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(bodyParser.json());

const IP_RATE_LIMIT_ENABLED = toBoolean(process.env.IP_RATE_LIMIT_ENABLED);
const IP_RATE_LIMIT_WINDOW_MS = parseInt(process.env.IP_RATE_LIMIT_WINDOW_MS);
const IP_RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.IP_RATE_LIMIT_MAX_REQUESTS);

if (IP_RATE_LIMIT_ENABLED) {
    const limiter = rateLimit({
        windowMs: IP_RATE_LIMIT_WINDOW_MS,
        max: IP_RATE_LIMIT_MAX_REQUESTS
    });
    app.use(limiter);
}

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
        if (!messages.length) {
            return res.status(400).json({
                error: {
                    message: "Messages array is empty",
                    type: "invalid_request_error",
                    code: 400
                }
            });
        }

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
        const awsCreds = {
            region: AWS_REGION,
            accessKeyId: AWS_ACCESS_KEY_ID,
            secretAccessKey: AWS_SECRET_ACCESS_KEY
        };

        const bedrockParams = {
            messages,
            model,
            max_tokens,
            stream,
            temperature,
            top_p
        };

        if (stream) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            });

            for await (const chunk of bedrockWrapper(awsCreds, bedrockParams, { logging: true })) {
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
            }

            res.write(`data: [DONE]\n\n`);
            res.end();
        } else {
            let completeResponse = '';
            const response = await bedrockWrapper(awsCreds, bedrockParams, { logging: true });
            for await (const data of response) {
                completeResponse += data;
            }

            res.setHeader('Content-Type', 'application/json');
            res.json({
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: model,
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

// 启动服务器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});