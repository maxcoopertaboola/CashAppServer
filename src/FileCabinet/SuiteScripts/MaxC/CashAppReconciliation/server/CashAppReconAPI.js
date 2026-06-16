/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */

define([
    'N/log',
    './utils/corsHandler',
    './utils/errorHandler',
    './routes/routes' // Ensure searchRoute.js exists if defining separate route files
], function(log, corsHandler, errorHandler, routes) {
    /**
     * Handles incoming Suitelet requests and routes them based on the "action" parameter.
     * @param {Object} context - Suitelet context.
     */
    function onRequest(context) {
        const request = context.request;
        const response = context.response;
        const allowedOrigin = '*'; // Update this as per your security requirements
        try {
            // Always set CORS headers
            corsHandler.setCorsHeaders(response, allowedOrigin);
            
            // Handle preflight OPTIONS request
            if (request.method === 'OPTIONS') {
                // Respond with CORS headers and no content
                response.write('', 200);
                return;
            }
            
            if (request.method === 'GET' || request.method === 'POST') {
                let body = {};
                
                // If method is POST, parse the JSON body
                if (request.method === 'POST') {
                    try {
                        body = request.body ? JSON.parse(request.body) : {};
                        log.debug({ title: 'Body', details: request.body });
                    } catch (parseError) {
                        throw new Error('Invalid JSON in request body.');
                    }
                }

                const action = request.parameters.action || '';
                const params = request.parameters; // Pass all parameters for flexibility

                // Handle Request Based on Action
                const result = routes.handleRequest(action, params, body);

                // Set response headers and body
                response.setHeader({ name: 'Content-Type', value: 'application/json' });
                response.write(JSON.stringify(result), 200);
            } else {
                // Handle unsupported HTTP methods
                response.setHeader({ name: 'Content-Type', value: 'application/json' });
                response.write(JSON.stringify({ success: false, message: 'Unsupported request method' }), 405); // 405 Method Not Allowed
            }
        } catch (error) {
            errorHandler.handleError(context.response, error, allowedOrigin);
        }
    }

    return {
        onRequest: onRequest
    };
});