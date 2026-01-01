// api.js - API client for OpenRouter and OpenAI-compatible endpoints

// Detect provider from model/endpoint string
function detectProvider(modelOrUrl) {
    if (!modelOrUrl || !modelOrUrl.trim()) {
        return { provider: 'openrouter', model: '', endpoint: '' };
    }

    const trimmed = modelOrUrl.trim();

    // URL = OpenAI-compatible
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        return { provider: 'openai', model: '', endpoint: trimmed };
    }

    // Check for provider targeting syntax (model::provider)
    if (trimmed.includes('::')) {
        const [model, targetProvider] = trimmed.split('::');
        return {
            provider: 'openrouter',
            model: model,
            endpoint: 'https://openrouter.ai/api/v1',
            targetProvider: targetProvider
        };
    }

    // Otherwise OpenRouter model
    return {
        provider: 'openrouter',
        model: trimmed,
        endpoint: 'https://openrouter.ai/api/v1'
    };
}

// Check if model needs untitled.txt trick (Anthropic models)
function needsUntitledTrick(model) {
    return model && model.toLowerCase().includes('anthropic');
}

// Build request body for completions
function buildCompletionRequest(settings, prompt) {
    const detection = detectProvider(settings.model);
    const isChat = settings.untitled_trick && needsUntitledTrick(detection.model);

    let body;

    if (isChat) {
        // Untitled.txt trick for Anthropic
        body = {
            model: detection.model,
            messages: [
                {
                    role: 'system',
                    content: 'The assistant is in CLI simulation mode, and responds to the user\'s CLI commands only with the output of the command.'
                },
                {
                    role: 'user',
                    content: '<cmd>cat untitled.txt</cmd> (5.8 KB)'
                },
                {
                    role: 'assistant',
                    content: prompt
                }
            ],
            max_tokens: settings.max_tokens || 32,
            temperature: settings.temperature || 1.0,
            stream: true
        };
    } else {
        // Standard completions
        body = {
            model: detection.model || settings.oai_model || '',
            prompt: prompt,
            max_tokens: settings.max_tokens || 32,
            temperature: settings.temperature || 1.0,
            min_p: settings.min_p || 0.01,
            stream: true
        };
    }

    // Add provider targeting if specified
    if (detection.targetProvider) {
        body.provider = {
            order: [detection.targetProvider],
            allow_fallbacks: false
        };
    }

    return { body, isChat, detection };
}

// Get endpoint URL for request
function getEndpointUrl(detection, isChat) {
    if (detection.provider === 'openai') {
        // OpenAI-compatible endpoint
        const base = detection.endpoint.replace(/\/$/, '');
        return isChat ? `${base}/chat/completions` : `${base}/completions`;
    } else {
        // OpenRouter
        return isChat
            ? 'https://openrouter.ai/api/v1/chat/completions'
            : 'https://openrouter.ai/api/v1/completions';
    }
}

// Get API key for request
function getApiKey(settings, detection) {
    if (detection.provider === 'openai') {
        return settings.oai_api_key || '';
    } else {
        return settings.api_key || '';
    }
}

// Stream completion from API
// abortController: optional, pass in to enable external cancellation
async function streamCompletion(settings, prompt, onChunk, onDone, onError, abortController = null) {
    const { body, isChat, detection } = buildCompletionRequest(settings, prompt);
    const url = getEndpointUrl(detection, isChat);
    const apiKey = getApiKey(settings, detection);

    const headers = {
        'Content-Type': 'application/json'
    };

    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    // Add OpenRouter specific headers
    if (detection.provider === 'openrouter') {
        headers['HTTP-Referer'] = window.location.origin;
        headers['X-Title'] = 'WebLoom';
    }

    let controller = abortController || new AbortController();

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(body),
            signal: controller.signal
        });

        if (!response.ok) {
            const errorText = await response.text();
            let errorMessage;
            try {
                const errorJson = JSON.parse(errorText);
                errorMessage = errorJson.error?.message || errorJson.message || errorText;
            } catch {
                errorMessage = errorText;
            }
            throw new Error(`API error ${response.status}: ${errorMessage}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';

        while (true) {
            const { done, value } = await reader.read();

            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6).trim();

                    if (data === '[DONE]') {
                        onDone(fullText);
                        return { text: fullText, cancel: () => controller.abort() };
                    }

                    try {
                        const parsed = JSON.parse(data);
                        let chunk = '';

                        if (isChat) {
                            // Chat completion format
                            chunk = parsed.choices?.[0]?.delta?.content || '';
                        } else {
                            // Text completion format
                            chunk = parsed.choices?.[0]?.text || '';
                        }

                        if (chunk) {
                            fullText += chunk;
                            onChunk(chunk, fullText);
                        }
                    } catch (e) {
                        // Ignore parse errors for partial data
                    }
                }
            }
        }

        onDone(fullText);
        return { text: fullText, cancel: () => controller.abort() };

    } catch (error) {
        if (error.name === 'AbortError') {
            onDone('');
        } else {
            onError(error);
        }
        return { text: '', cancel: () => { } };
    }
}

// Get user-friendly error description
function getErrorDescription(statusCode) {
    const descriptions = {
        400: "Bad Request - Invalid parameters. Check your model settings.",
        401: "Invalid API Key - Your API key is invalid or expired.",
        402: "Insufficient Credits - Add more credits to your account.",
        403: "Content Blocked - Your input was flagged by moderation.",
        404: "Model Not Found - The selected model doesn't exist.",
        408: "Request Timeout - Try a shorter prompt or different model.",
        429: "Rate Limited - Too many requests. Wait and try again.",
        500: "Server Error - The API is experiencing issues.",
        502: "Model Unavailable - The model is down. Try another.",
        503: "No Provider Available - No provider can serve this request."
    };

    return descriptions[statusCode] || `Unknown error (${statusCode})`;
}

// Parse error message for status code
function parseErrorStatus(message) {
    const match = message.match(/(?:API error|Status|error):\s*(\d{3})/i);
    if (match) return parseInt(match[1]);

    const codeMatch = message.match(/\b(4\d{2}|5\d{2})\b/);
    if (codeMatch) return parseInt(codeMatch[1]);

    return null;
}
