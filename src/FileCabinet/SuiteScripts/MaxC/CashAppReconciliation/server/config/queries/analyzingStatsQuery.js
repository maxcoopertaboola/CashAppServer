/**
 * Queries/analyzingStatsQuery.js
 * SuiteQL template for the analyzing_stats search type.
 *
 * Template placeholders replaced at runtime in queryBuilder.js:
 *   {SUBSIDIARY_FILTER}  →  WHERE cpat.custrecord_pri_cashapp_linked_subsidiary IN (14, 26, 24)
 *                           or '' (omitted) when no subsidiaries are provided
 *
 * Classification order (mutually exclusive, preserves original bucket semantics):
 *   1. Voided        — matchstatus = 6
 *   2. Auto Applied  — has systemnote (newvalue='Fully Applied', context='MPR')
 *   3. Exact Match   — custrecord_tb_exact_match = 'T'
 *   4. Review        — matchstatus = 2  OR  has systemnote (oldvalue='Review', context IN ('UIF','SLT'))
 *   5. Not Matched   — everything else
 *
 * Performance notes:
 *   - Previous version used 5 UNION ALL branches → 5 scans of cpat and up to
 *     6 separate visits to systemnote (INNER JOIN + correlated EXISTS/NOT EXISTS).
 *   - This version scans cpat once and systemnote once (pre-aggregated into a
 *     flags CTE per recordid), then classifies each row with a single CASE.
 *   - The sn_flags CTE is further narrowed by
 *     sn.recordtypeid = (internal id of 'customrecord_pri_cashapp_transaction')
 *     so Oracle uses the (recordtypeid, recordid) index on systemnote and does
 *     not scan notes for unrelated record types. The internal id is resolved
 *     inline via a subquery against customrecordtype (scriptid → id), so the
 *     query is portable across accounts where the custom-record internal id
 *     may differ.
 *
 * Result columns:
 *   subsidiary_id, subsidiary_name,
 *   bank_account_id, bank_account_name,
 *   result_count, status
 *
 * Names are resolved via explicit LEFT JOINs to `subsidiary` (sub.name) and
 * `account` (acc.fullName) — BUILTIN.DF is not used because it is not reliable
 * inside aggregated SuiteQL in this account.
 */

define([], function() {
    const analyzingStatsSuiteQL = `
        WITH sn_flags AS (
            SELECT
                sn.recordid AS rec_id,
                MAX(CASE WHEN sn.newvalue = 'Fully Applied' AND sn.context = 'MPR'                        THEN 1 ELSE 0 END) AS has_fully_applied_mpr,
                MAX(CASE WHEN sn.oldvalue = 'Review'        AND sn.context IN ('UIF', 'SLT')              THEN 1 ELSE 0 END) AS has_review_uif_slt
            FROM
                systemnote AS sn
            WHERE
                sn.recordtypeid = (
                    SELECT crt.internalId
                    FROM customrecordtype AS crt
                    WHERE crt.scriptid = 'CUSTOMRECORD_PRI_CASHAPP_TRANSACTION'
                )
                AND (
                    (sn.newvalue = 'Fully Applied' AND sn.context = 'MPR')
                    OR (sn.oldvalue = 'Review' AND sn.context IN ('UIF', 'SLT'))
                )
            GROUP BY
                sn.recordid
        )
        SELECT
            cpat.custrecord_pri_cashapp_linked_subsidiary AS subsidiary_id,
            sub.name                                      AS subsidiary_name,
            cpat.custrecord_pri_cashapp_linked_bank_acct  AS bank_account_id,
            acc.accountSearchDisplayName                  AS bank_account_name,
            COUNT(*)                                      AS result_count,
            CASE
                WHEN cpat.custrecord_pri_cashapp_trans_matchstatus = 6           THEN 'Voided'
                WHEN NVL(sn_flags.has_fully_applied_mpr, 0) = 1                  THEN 'Auto Applied'
                WHEN cpat.custrecord_tb_exact_match = 'T'                        THEN 'Exact Match'
                WHEN cpat.custrecord_pri_cashapp_trans_matchstatus = 2
                  OR NVL(sn_flags.has_review_uif_slt, 0) = 1                     THEN 'Review'
                ELSE                                                                  'Not Matched'
            END AS status
        FROM
            customrecord_pri_cashapp_transaction AS cpat
            LEFT JOIN sn_flags    ON sn_flags.rec_id = cpat.id
            LEFT JOIN subsidiary  AS sub ON sub.id   = cpat.custrecord_pri_cashapp_linked_subsidiary
            LEFT JOIN account     AS acc ON acc.id   = cpat.custrecord_pri_cashapp_linked_bank_acct
        {SUBSIDIARY_FILTER}
        GROUP BY
            cpat.custrecord_pri_cashapp_linked_subsidiary,
            sub.name,
            cpat.custrecord_pri_cashapp_linked_bank_acct,
            acc.accountSearchDisplayName,
            CASE
                WHEN cpat.custrecord_pri_cashapp_trans_matchstatus = 6           THEN 'Voided'
                WHEN NVL(sn_flags.has_fully_applied_mpr, 0) = 1                  THEN 'Auto Applied'
                WHEN cpat.custrecord_tb_exact_match = 'T'                        THEN 'Exact Match'
                WHEN cpat.custrecord_pri_cashapp_trans_matchstatus = 2
                  OR NVL(sn_flags.has_review_uif_slt, 0) = 1                     THEN 'Review'
                ELSE                                                                  'Not Matched'
            END
    `;

    return {
        analyzingStatsSuiteQL: analyzingStatsSuiteQL
    };
});
