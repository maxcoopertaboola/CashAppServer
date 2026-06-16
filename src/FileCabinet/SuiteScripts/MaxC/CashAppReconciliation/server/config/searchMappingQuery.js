/**
 * Config/mappingQuery.js
 * Provides query configurations for the Suitelet.
 * Complex query building is delegated to queryBuilder.js.
 */

define(['N/search', 'N/query', 'N/log', './queryBuilder'], function(search, query, log, queryBuilder) {

    /**
     * Retrieves the mapping configuration based on search type and query.
     * @param {string} searchType    - The type of search to perform.
     * @param {string} searchQuery   - The search term provided by the user.
     *   For 'cash_app_transactions' and 'analyzing_stats': comma-separated subsidiary IDs (e.g. '14,26,24').
     * @param {string} subsidiary    - The subsidiary ID to filter by (optional, currently unused).
     * @param {string} [matchStatusMode='open'] - 'open' (NOT IN 4,5,6) or 'matched' (IN 4,5,6).
     *   Applies to 'cash_app_transactions' only.
     * @param {string} [dateFrom]    - Start date filter (inclusive), format 'M/D/YYYY'.
     * @param {string} [dateTo]      - End date filter (inclusive), format 'M/D/YYYY'.
     * @returns {Object}             - The configuration object for the specified search type.
     */
    function getMappingQuery(searchType, searchQuery, subsidiary, matchStatusMode, dateFrom, dateTo) {
        var lowerCaseQuery    = searchQuery ? searchQuery.toString().toLowerCase() : '';
        var dateFilter = (dateFrom || dateTo) ? { from: dateFrom, to: dateTo } : null;
        var cashApp                      = queryBuilder.buildCashAppTransactions(searchQuery, matchStatusMode, dateFilter);
        var analyzingStats               = queryBuilder.buildAnalyzingStats(searchQuery);
        var getAnalyzingStats            = queryBuilder.buildGetAnalyzingStats(searchQuery);
        var currentStats                 = queryBuilder.buildCurrentStats(searchQuery);
        var accountBalanceByBankAccount  = queryBuilder.buildAccountBalanceByBankAccount(searchQuery);
        var relatedCashAppTransactions   = queryBuilder.buildRelatedCashAppTransactions(searchQuery);
        var invoicesByIds                = queryBuilder.buildInvoicesByIds(searchQuery);

        var mappingQuery = {

            customer_name: {
                type: 'sql',
                query: `
                    SELECT id, entityid, fullname
                    FROM customer
                    WHERE LOWER(fullname) LIKE ?
                `,
                params: ['%' + lowerCaseQuery + '%'],
                responseFields: ['fullname'],
                isSearch: true
            },

            subsidiary_name: {
                type: 'sql',
                query: `
                    SELECT id, name, legalname
                    FROM subsidiary
                    WHERE LOWER(name) LIKE ?
                `,
                params: ['%' + lowerCaseQuery + '%'],
                responseFields: ['name', 'legalname'],
                isSearch: true
            },

            cash_app_transactions: {
                type: 'sql',
                query: cashApp.query,
                params: cashApp.params,
                responseFields: [],
                isSearch: false
            },
            
            accounts_balances: {
                type: 'sql',
                query: accountBalanceByBankAccount.query,
                params: accountBalanceByBankAccount.params,
                responseFields: ['account_number', 'balance'],
                isSearch: true
            },

            related_cashapp_transactions: {
                type: 'sql',
                query: relatedCashAppTransactions.query,
                params: relatedCashAppTransactions.params,
                responseFields: ['invoice_id', 'invoice_number'],
                isSearch: true
            },

            invoices_by_ids: {
                type: 'sql',
                query: invoicesByIds.query,
                params: invoicesByIds.params,
                responseFields: ['invoice_id', 'invoice_number'],
                isSearch: true
            },
            
            
            open_invoices_by_customer: {
                type: 'sql',
                query: `
                    SELECT
                        t.id AS invoice_id,
                        t.trandate AS invoice_date,
                        t.tranid AS invoice_number,
                        currency.name AS invoice_currency,
                        t.foreigntotal AS invoice_total,
                        t.custbody_stc_amount_after_discount AS invoice_subtotal,
                        t.foreignAmountUnpaid AS invoice_unpaid_balance
                    FROM
                        transaction AS t
                    LEFT JOIN
                        currency AS currency
                        ON t.currency = currency.id
                    WHERE t.status = 'CustInvc:A'
                    AND t.entity = ?
                `,
                params: [searchQuery],
                responseFields: ['invoice_id', 'invoice_number'],
                isSearch: true
            },

            open_invoices_by_doc_number: {
                type: 'sql',
                query: `
                    SELECT
                        t.id AS invoice_id,
                        t.trandate AS invoice_date,
                        t.tranid AS invoice_number,
                        currency.name AS invoice_currency,
                        t.foreigntotal AS invoice_total,
                        t.custbody_stc_amount_after_discount AS invoice_subtotal,
                        t.foreignAmountUnpaid AS invoice_unpaid_balance
                    FROM
                        transaction AS t
                    LEFT JOIN
                        currency AS currency
                        ON t.currency = currency.id
                    WHERE t.status = 'CustInvc:A'
                    AND t.tranid = ?
                `,
                params: [searchQuery],
                responseFields: ['invoice_id', 'invoice_number'],
                isSearch: true
            },


            analyzing_stats: {
                type: 'sql',
                query: analyzingStats.query,
                params: analyzingStats.params,
                responseFields: ['subsidiary', 'bank_account', 'result_count'],
                isSearch: true
            },
            
            get_analyzing_stats: {
                type: 'sql',
                query: getAnalyzingStats.query,
                params: getAnalyzingStats.params,
                responseFields: ['stats_id', 'subsidiary_id'],
                isSearch: true
            },

            current_stats: {
                type: 'sql',
                query: currentStats.query,
                params: currentStats.params,
                responseFields: ['current_status', 'result_count'],
                isSearch: true
            },

            globalSearch: {
                type: 'global',
                globalSearchConfig: {
                    keywords: searchQuery
                },
                isSearch: true
            }
        };

        return mappingQuery[searchType];
    }

    return {
        getMappingQuery: getMappingQuery
    };
});
