/**
    * Utils/corsHandler.js
    * Enhanced CORS handler for multiple origins.
    */

define([], function() {
    const allowedOrigins = ['*'];

    /**
     * Sets CORS headers on the response object based on the request origin.
     * @param {Object} response - The response object from the Suitelet context.
     * @param {string} requestOrigin - The Origin header from the request.
     */
    function setCorsHeaders(response, requestOrigin) {
        if (allowedOrigins.includes(requestOrigin)) {
            response.setHeader('Access-Control-Allow-Origin', requestOrigin);
        } else {
            response.setHeader('Access-Control-Allow-Origin', 'null'); // Or omit the header
        }
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        response.setHeader('Access-Control-Max-Age', '3600'); // Optional: Cache the preflight response
    }

    return {
        setCorsHeaders: setCorsHeaders
    };
});