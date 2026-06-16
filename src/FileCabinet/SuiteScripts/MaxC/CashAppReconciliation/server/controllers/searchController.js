/**
 * Controllers/searchController.js
 * Handles the business logic for search requests.
 */

define([ 'N/log', '../config/searchMappingQuery', '../services/searchService', '../utils/responseFormatter'], 
    function(log, mappingQuery, searchService, responseFormatter) {
        
    /**
     * Processes a search request based on search type and query.
     * @param {string} searchType - The type of search to perform.
     * @param {string} searchQuery - The search term provided by the user.
     *   For 'analyzing_stats': comma-separated subsidiary IDs (e.g. '14,26,24').
     * @param {string} subsidiary - The subsidiary ID to filter by (optional).
     * @param {string} [matchStatusMode] - Controls match-status filter for cash_app_transactions.
     * @param {string} [dateFrom] - Start date filter (inclusive), format 'M/D/YYYY'.
     * @param {string} [dateTo]   - End date filter (inclusive), format 'M/D/YYYY'.
     * @returns {Array<Object>} - Formatted search results.
     */
    function processSearch(searchType, searchQuery, subsidiary, matchStatusMode, dateFrom, dateTo) {
        // Retrieve mapping configuration
        const config = mappingQuery.getMappingQuery(searchType, searchQuery, subsidiary, matchStatusMode, dateFrom, dateTo);
        log.debug({ title: 'config', details: config });
        if (!config) {
            throw new Error('Invalid or unsupported search type provided.');
        }

        let results = [];

        if (config.type === 'sql') {
            // Execute SuiteQL Query
            const queryResults = searchService.executeSuiteQL(config);
            // Format Results
            log.debug({ title: 'queryResults', details: queryResults });
            results = responseFormatter.formatSuiteQLResults(queryResults, config.responseFields, config.isSearch);
        } else if (config.type === 'ss') {
            // Execute Saved Search
            const searchResults = searchService.executeSavedSearch(config);
            // Format Results
            log.debug({ title: 'queryResults', details: searchResults });
            results = responseFormatter.formatSavedSearchResults(searchResults, config.responseFields, config.isSearch);
        } else if (config.type === 'global') {
            // Execute Global Search
            const globalResults = searchService.executeGlobalSearch(config);
            // Return native results without formatting
            log.debug({ title: 'globalResults', details: globalResults });
            results = globalResults;
        }

        return results;
    }

    return {
        processSearch: processSearch
    };
});