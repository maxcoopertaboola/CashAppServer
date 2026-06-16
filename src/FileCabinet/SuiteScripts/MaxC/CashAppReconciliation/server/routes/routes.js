/**
 * Routes/Routes.js
 * Defines route handlers for specific actions.
 */

define([ '../controllers/matchController', '../controllers/searchController', '../controllers/userDataController'], function(matchController, searchController, userDataController) {
    
    return {
        /**
         * Routes the action parameter to its corresponding handler.
         * @param {string} action - The action indicating the route/controller to use.
         * @param {Object} params - The parameters extracted from the request.
         * @param {Object} body   - The parsed JSON body of the request.
         * @returns {Object} - The action response.
         */
        handleRequest: function(action, params, body) {
            const routes = {         
                search: ({ type = '', q = '', subsidiary = '' , matchStatusMode = '', dateFrom = '', dateTo = '' }) => searchController.processSearch(type, q, subsidiary, matchStatusMode, dateFrom, dateTo),
                getMatchData:                (params, body) => matchController.processGetMatchData(params, body),
                applyMatchData:              (params, body) => matchController.processApplyMatchData(params, body),
                moveBalanceToCustomer:       (params, body) => matchController.processMoveBalanceToCustomer(params, body),
                moveBalanceToCustomerDeposit:(params, body) => matchController.processMoveBalanceToCustomerDeposit(params, body),
                cashSalePrepayment:         (params, body) => matchController.processCashSalePrepayment(params, body),
                voidTransaction:             (params, body) => matchController.processVoidTransaction(params, body),
                suggestInvoices:             (params)       => matchController.processSuggestInvoices(params),

                getUserData: () => userDataController.processGetUserData(),
            };

            const routeHandler = routes[action];

            if (!routeHandler) {
                throw new Error(`Invalid or unsupported action: ${action}`);
            }

            return routeHandler(params, body);
        }
    };
});