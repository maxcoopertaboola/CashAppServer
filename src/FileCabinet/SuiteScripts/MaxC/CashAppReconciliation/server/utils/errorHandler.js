/**
 * Utils/errorHandler.js
 * Handles error responses for the Suitelet.
 */

define(['N/log'], function(log) {
    /**
     * Formats and sends an error response.
     * @param {Object} response - The response object from the Suitelet context.
     * @param {Error} error - The error object.
     */
    function handleError(response, error) {
        response.setHeader({
            name: 'Content-Type',
            value: 'application/json'
        });
        response.write(JSON.stringify({ error: error.message }));
        
    }

    return {
        handleError: handleError
    };
});