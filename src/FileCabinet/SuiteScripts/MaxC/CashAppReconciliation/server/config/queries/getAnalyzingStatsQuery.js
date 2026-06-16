/**
 * Queries/getAnalyzingStatsQuery.js
 * SuiteQL template for the get_analyzing_stats search type.
 * Reads pre-computed rows from customrecord_tb_cashapp_stats.
 *
 * Template placeholder replaced at runtime in queryBuilder.js:
 *   {SUBSIDIARY_FILTER}  →  WHERE stats.custrecord_tb_cashapp_stat_subsidiary IN (?, ?)
 *                           or '' (omitted) when no subsidiaries are provided
 *
 * Result columns: stats_id, subsidiary_id, subsidiary_name,
 *                 bank_account_id, bank_account_name, status, result_count
 */

define([], function() {
    const getAnalyzingStatsSuiteQL = `
        SELECT
            stats.id AS stats_id,
            stats.custrecord_tb_cashapp_stat_subsidiary AS subsidiary_id,
            BUILTIN.DF(stats.custrecord_tb_cashapp_stat_subsidiary) AS subsidiary_name,
            stats.custrecord_tb_cashapp_stat_account AS bank_account_id,
            BUILTIN.DF(stats.custrecord_tb_cashapp_stat_account) AS bank_account_name,
            stats.custrecord_tb_cashapp_stat_status AS status,
            stats.custrecord_tb_cashapp_stat_count AS result_count
        FROM
            customrecord_tb_cashapp_stats AS stats
        {SUBSIDIARY_FILTER}
    `;

    return {
        getAnalyzingStatsSuiteQL: getAnalyzingStatsSuiteQL
    };
});
