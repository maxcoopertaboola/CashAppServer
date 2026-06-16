/**
 * controllers/userDataController.js
 * Controller for handling User Data operations.
 */

define(['../services/userDataService', 'N/log'], function(userDataService, log) {
    return {
        /**
         * Processes the get user data request.
         * @returns {Object} - The response object containing user data.
         */
        processGetUserData: function() {
            try {
                // Call the service to get current user data
                const userData = userDataService.getCurrentUserData();

                // Log success
                log.debug('Get User Data Processed', `User ID: ${userData.data.id}`);

                // Return success response with user data
                return {
                    success: true,
                    message: 'User data retrieved successfully.',
                    data: userData.data
                };
            } catch (error) {
                log.error('Error in processGetUserData', error);
                // Throw to be caught by the error handler in routes
                throw error;
            }
        }
    };
}); 