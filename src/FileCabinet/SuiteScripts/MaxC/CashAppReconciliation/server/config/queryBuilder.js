/**
 * Config/queryBuilder.js
 * Builds parameterised SuiteQL query objects for complex search types.
 * Each exported function accepts raw caller inputs and returns { query, params }.
 */

define([
    './cashAppTransactionsQuery',
    './appliedCashAppTransactionsQuery',
    './queries/analyzingStatsQuery',
    './queries/getAnalyzingStatsQuery',
    './queries/currentStatsQuery'
], function(cashAppTransactionsQuery, appliedCashAppTransactionsQuery, analyzingStatsQuery, getAnalyzingStatsQuery, currentStatsQuery) {

    var MATCH_STATUS_MODES = {
        open:    'NOT IN (4,5,6)',
        matched: 'IN (4,5,6)'
    };

    // ─── shared helpers ─────────────────────────────────────────────────────────

    /**
     * Parses a comma-separated string of subsidiary IDs into an array of integers.
     * @param {string} raw - e.g. '14,26,24'
     * @returns {number[]}
     */
    function parseSubsidiaryIds(raw) {
        if (!raw) return [];
        return raw.toString()
            .split(',')
            .map(function(id) { return parseInt(id.trim(), 10); })
            .filter(function(id) { return !isNaN(id); });
    }

    /**
     * Builds an optional WHERE clause for a subsidiary IN filter.
     * Returns an empty string when no IDs are provided (removes the filter).
     * @param {number[]} subsidiaryIds
     * @param {string}   columnExpr   - fully-qualified column, e.g. 'stats.custrecord_tb_cashapp_stat_subsidiary'
     * @returns {string}
     */
    function _buildSubsidiaryWhere(subsidiaryIds, columnExpr) {
        if (subsidiaryIds.length === 0) return '';
        var placeholders = subsidiaryIds.map(function() { return '?'; }).join(', ');
        return 'WHERE ' + columnExpr + ' IN (' + placeholders + ')';
    }

    // ─── builders ───────────────────────────────────────────────────────────────

    /**
     * Builds the cash_app_transactions query.
     * @param {string} searchQuery       - Comma-separated subsidiary IDs (e.g. '14,26,24').
     * @param {string} [matchStatusMode] - 'open' or 'matched'.
     * @param {Object} [dateFilter]      - Optional date range filter.
     * @param {string} [dateFilter.from] - Start date (inclusive), format 'M/D/YYYY' (e.g. '1/15/2024').
     * @param {string} [dateFilter.to]   - End date (inclusive), format 'M/D/YYYY' (e.g. '3/31/2024').
     * @returns {{ query: string, params: (number|string)[] }}
     */
    function buildCashAppTransactions(searchQuery, matchStatusMode, dateFilter) {
        var subsidiaryIds     = parseSubsidiaryIds(searchQuery);
        var matchStatusFilter = MATCH_STATUS_MODES[matchStatusMode] || MATCH_STATUS_MODES.open;

        var querySource = matchStatusMode === 'matched'
            ? appliedCashAppTransactionsQuery
            : cashAppTransactionsQuery;

        var sql = querySource.exportInvoicesSuiteQL
            .replace(/\{MATCH_STATUS_FILTER\}/g, matchStatusFilter);

        var sectionCount = (sql.match(/IN \(\?\)/g) || []).length;

        if (subsidiaryIds.length > 0) {
            var placeholders = subsidiaryIds.map(function() { return '?'; }).join(', ');
            sql = sql.replace(/IN \(\?\)/g, 'IN (' + placeholders + ')');
        } else {
            sql = sql.replace(/AND ct\.custrecord_pri_cashapp_linked_subsidiary IN \(\?\)/g, '');
        }

        var dateParams = [];
        var dateClause = '';
        if (dateFilter) {
            if (dateFilter.from) {
                dateClause += " AND ct.custrecord_pri_cashapp_trans_date >= TO_DATE(?, 'MM/DD/YYYY')";
                dateParams.push(dateFilter.from);
            }
            if (dateFilter.to) {
                dateClause += " AND ct.custrecord_pri_cashapp_trans_date <= TO_DATE(?, 'MM/DD/YYYY')";
                dateParams.push(dateFilter.to);
            }
        }
        sql = sql.replace(/\{DATE_FILTER\}/g, dateClause);

        var sectionParams = subsidiaryIds.concat(dateParams);
        var params = [];
        for (var i = 0; i < sectionCount; i++) {
            params = params.concat(sectionParams);
        }

        return { query: sql, params: params };
    }

    /**
     * Builds the analyzing_stats query (heavy live aggregation across 5 buckets).
     *
     * Subsidiary IDs are inlined rather than passed as bind parameters because
     * SuiteQL does not support bind params inside a CTE WHERE clause reliably.
     * IDs are safe integers parsed from a script parameter.
     *
     * @param {string} searchQuery - Comma-separated subsidiary IDs (e.g. '14,26,24').
     * @returns {{ query: string, params: Array }}
     */
    function buildAnalyzingStats(searchQuery) {
        var subsidiaryIds = parseSubsidiaryIds(searchQuery);

        var subsidiaryFilter = subsidiaryIds.length > 0
            ? 'WHERE cpat.custrecord_pri_cashapp_linked_subsidiary IN (' + subsidiaryIds.join(', ') + ')'
            : '';

        var sql = analyzingStatsQuery.analyzingStatsSuiteQL
            .replace(/\{SUBSIDIARY_FILTER\}/g, subsidiaryFilter);

        return { query: sql, params: [] };
    }

    /**
     * Builds the get_analyzing_stats query — reads pre-computed rows from
     * customrecord_tb_cashapp_stats with an optional subsidiary filter.
     * @param {string} searchQuery - Comma-separated subsidiary IDs (e.g. '14,26').
     * @returns {{ query: string, params: number[] }}
     */
    function buildGetAnalyzingStats(searchQuery) {
        var subsidiaryIds = parseSubsidiaryIds(searchQuery);
        var sql = getAnalyzingStatsQuery.getAnalyzingStatsSuiteQL
            .replace(/\{SUBSIDIARY_FILTER\}/g, _buildSubsidiaryWhere(subsidiaryIds, 'stats.custrecord_tb_cashapp_stat_subsidiary'));

        return { query: sql, params: subsidiaryIds };
    }

    /**
     * Builds the current_stats query — live count per match-status bucket
     * directly from customrecord_pri_cashapp_transaction.
     * @param {string} searchQuery - Comma-separated subsidiary IDs (e.g. '14,26').
     * @returns {{ query: string, params: number[] }}
     */
    function buildCurrentStats(searchQuery) {
        var subsidiaryIds = parseSubsidiaryIds(searchQuery);
        var sql = currentStatsQuery.currentStatsSuiteQL
            .replace(/\{SUBSIDIARY_FILTER\}/g, _buildSubsidiaryWhere(subsidiaryIds, 'cpat.custrecord_pri_cashapp_linked_subsidiary'));

        return { query: sql, params: subsidiaryIds };
    }

    /**
     * Builds the related_cashapp_transactions query — fetches invoice details
     * linked to one or more CashApp transaction IDs.
     *
     * @param {string} searchQuery - Comma-separated CashApp transaction IDs (e.g. '123' or '123,456').
     * @returns {{ query: string, params: number[] }}
     */
    function buildRelatedCashAppTransactions(searchQuery) {
        var ids = parseSubsidiaryIds(searchQuery);
        if (ids.length === 0) {
            return { query: 'SELECT 1 FROM DUAL WHERE 1=0', params: [] };
        }

        var placeholders = ids.map(function() { return '?'; }).join(', ');

        var sql = `
            SELECT
                'payments' AS transaction_category,
                t.id AS invoice_id,
                t.trandate AS invoice_date,
                t.tranid AS invoice_number,
                t.entity AS invoice_entity_id,
                invoice_entity_customer.fullname AS invoice_entity_name,
                t.currency AS invoice_currency_id,
                currency.name AS invoice_currency,
                t.custbody_stc_amount_after_discount AS invoice_subtotal,
                t.type AS invoice_type,
                CASE
                    WHEN t.type = 'Journal' THEN (SELECT SUM(tl.creditforeignamount) FROM transactionline tl WHERE tl.transaction = t.id)
                    ELSE t.foreigntotal
                END AS invoice_total,
                t.foreignAmountUnpaid AS invoice_unpaid_balance,
                ROUND(1 - (t.custbody_stc_amount_after_discount /
                    NULLIF(
                        CASE
                            WHEN t.type = 'Journal' THEN (SELECT SUM(tl.creditforeignamount) FROM transactionline tl WHERE tl.transaction = t.id)
                            ELSE t.foreigntotal
                        END, 0)
                ), 2) AS tax_precentage
            FROM
                transaction AS t
            LEFT JOIN
                customer AS invoice_entity_customer
                ON t.entity = invoice_entity_customer.id
            LEFT JOIN
                currency AS currency
                ON t.currency = currency.id
            WHERE
                t.custbody_pri_cashapp_transaction IN (` + placeholders + `)
        `;

        return { query: sql, params: ids };
    }

    /**
     * Builds the invoices_by_ids query — fetches invoice details for a list of
     * internal IDs, returning the same column shape as related_cashapp_transactions.
     *
     * @param {string} searchQuery - Comma-separated invoice internal IDs (e.g. '654654,56562,545522').
     * @returns {{ query: string, params: number[] }}
     */
    function buildInvoicesByIds(searchQuery) {
        var invoiceIds = parseSubsidiaryIds(searchQuery);
        if (invoiceIds.length === 0) {
            return { query: 'SELECT 1 FROM DUAL WHERE 1=0', params: [] };
        }

        var placeholders = invoiceIds.map(function() { return '?'; }).join(', ');

        var sql = `
            SELECT
                'payments' AS transaction_category,
                t.id AS invoice_id,
                t.trandate AS invoice_date,
                t.tranid AS invoice_number,
                t.entity AS invoice_entity_id,
                invoice_entity_customer.fullname AS invoice_entity_name,
                t.currency AS invoice_currency_id,
                currency.name AS invoice_currency,
                t.custbody_stc_amount_after_discount AS invoice_subtotal,
                t.type AS invoice_type,
                CASE
                    WHEN t.type = 'Journal' THEN (SELECT SUM(tl.creditforeignamount) FROM transactionline tl WHERE tl.transaction = t.id)
                    ELSE t.foreigntotal
                END AS invoice_total,
                t.foreignAmountUnpaid AS invoice_unpaid_balance,
                ROUND(1 - (t.custbody_stc_amount_after_discount /
                    NULLIF(
                        CASE
                            WHEN t.type = 'Journal' THEN (SELECT SUM(tl.creditforeignamount) FROM transactionline tl WHERE tl.transaction = t.id)
                            ELSE t.foreigntotal
                        END, 0)
                ), 2) AS tax_precentage
            FROM
                transaction AS t
            LEFT JOIN
                customer AS invoice_entity_customer
                ON t.entity = invoice_entity_customer.id
            LEFT JOIN
                currency AS currency
                ON t.currency = currency.id
            WHERE
                t.id IN (` + placeholders + `)
        `;

        return { query: sql, params: invoiceIds };
    }

    /**
     * Builds the account_balance_by_bank_account query.
     *
     * Subsidiary IDs are inlined (not bound) — same rationale as buildAnalyzingStats.
     *
     * Currency conversion: if the bank account's currency differs from the
     * subsidiary's base currency the line amount is converted using the
     * transaction exchange-rate (tal.amount * t.exchangerate); otherwise the
     * raw tal.amount is used.
     *
     * @param {string} searchQuery - Comma-separated subsidiary IDs (e.g. '14,26,24').
     * @returns {{ query: string, params: Array }}
     */
    function buildAccountBalanceByBankAccount(searchQuery) {
        var subsidiaryIds = parseSubsidiaryIds(searchQuery);

        var subsidiaryFilter = subsidiaryIds.length > 0
            ? 'AND asm.subsidiary IN (' + subsidiaryIds.join(', ') + ')'
            : '';

        var sql = `
            SELECT
                a.acctNumber AS account_number, 
                a.accountSearchDisplayName AS account_name,
                a.subsidiary AS subsidiary_id, 
                BUILTIN.DF(a.subsidiary) AS subsidiary_name,
                a.currency AS currency_id,
                BUILTIN.DF(a.currency) AS currency_name, 
                a.fxBalance AS balance
            FROM 
                account AS a 
                INNER JOIN 
                AccountSubsidiaryMap asm ON asm.account = a.id
            WHERE 
                a.acctType = 'Bank' 
                {SUBSIDIARY_FILTER}
                AND a.fxBalance >= 1
        `.replace(/\{SUBSIDIARY_FILTER\}/g, subsidiaryFilter);

        return { query: sql, params: [] };
    }

    return {
        buildCashAppTransactions:           buildCashAppTransactions,
        buildAnalyzingStats:                buildAnalyzingStats,
        buildGetAnalyzingStats:             buildGetAnalyzingStats,
        buildCurrentStats:                  buildCurrentStats,
        buildAccountBalanceByBankAccount:   buildAccountBalanceByBankAccount,
        buildRelatedCashAppTransactions:    buildRelatedCashAppTransactions,
        buildInvoicesByIds:                 buildInvoicesByIds
    };
});
