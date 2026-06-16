/**
 * Services/searchService.js
 * Handles the execution of searches based on provided configurations.
 */

define(['N/query', 'N/search'], function(query, search) {
    /**
     * Executes a SuiteQL query based on the provided configuration.
     * @param {Object} config - The SuiteQL configuration object.
     * @returns {Array<Object>} - The SuiteQL query results.
     */
    function executeSuiteQL(config) {
        const queryOptions = {
            query: config.query,
            params: config.params
        };
        return query.runSuiteQL(queryOptions).asMappedResults();
    }

    /**
     * Executes a Saved Search based on the provided configuration.
     * @param {Object} config - The Saved Search configuration object.
     * @returns {Array<Object>} - The Saved Search results.
     */
    function executeSavedSearch(config) {
        log.debug({ title: 'executing SS', details: config });
        const savedSearch = search.create(config.searchConfig);
        log.debug({ title: 'executing SS', details: savedSearch });
        return savedSearch.run().getRange({
            start: 0,
            end: 1000 // Adjust as needed
        });
    }

    /**
     * Executes a Global Search based on the provided configuration.
     * @param {Object} config - The Global Search configuration object.
     * @returns {Array<Object>} - The Global Search results (natively returned).
     */
    function executeGlobalSearch(config) {
        log.debug({ title: 'executing Global Search', details: config });
        return search.global(config.globalSearchConfig);
    }

    return {
        executeSuiteQL: executeSuiteQL,
        executeSavedSearch: executeSavedSearch,
        executeGlobalSearch: executeGlobalSearch
    };
});