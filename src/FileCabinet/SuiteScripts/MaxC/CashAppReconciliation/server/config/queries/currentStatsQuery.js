/**
 * Queries/currentStatsQuery.js
 * SuiteQL template for the current_stats search type.
 * Returns a live count per match-status bucket directly from the transaction record.
 *
 * Template placeholder replaced at runtime in queryBuilder.js:
 *   {SUBSIDIARY_FILTER}  →  WHERE cpat.custrecord_pri_cashapp_linked_subsidiary IN (?, ?)
 *                           or '' (omitted) when no subsidiaries are provided
 *
 * Result columns: current_status, result_count
 */

define([], function() {
    const currentStatsSuiteQL = `
        SELECT
            CASE
                WHEN cpat.custrecord_tb_exact_match = 'T' THEN 'Exact Match'
                ELSE BUILTIN.DF(cpat.custrecord_pri_cashapp_trans_matchstatus)
            END AS current_status,
            COUNT(DISTINCT cpat.id) AS result_count
        FROM
            customrecord_pri_cashapp_transaction AS cpat
        {SUBSIDIARY_FILTER}
        GROUP BY
            CASE
                WHEN cpat.custrecord_tb_exact_match = 'T' THEN 'Exact Match'
                ELSE BUILTIN.DF(cpat.custrecord_pri_cashapp_trans_matchstatus)
            END
    `;

    return {
        currentStatsSuiteQL: currentStatsSuiteQL
    };
});
