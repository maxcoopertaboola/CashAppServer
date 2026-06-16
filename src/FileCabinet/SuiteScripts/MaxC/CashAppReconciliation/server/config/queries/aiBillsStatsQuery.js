/**
 * Queries/aiBillsStatsQuery.js
 * Contains SuiteQL queries for AI Bills statistics.
 */

define([], function() {
    const exportaiBillsStatsSuiteQL = `
        SELECT
            -- Today's created bills
            COUNT(CASE WHEN TRUNC(created) = TRUNC(SYSDATE) THEN 1 END) AS todaysCreatedBills,

            -- Yesterday's created bills
            COUNT(CASE WHEN TRUNC(created) = TRUNC(SYSDATE - 1) THEN 1 END) AS yesterdaysCreatedBills,

            -- Percent change from yesterday to today
            ROUND(
                CASE 
                WHEN COUNT(CASE WHEN TRUNC(created) = TRUNC(SYSDATE - 1) THEN 1 END) = 0 THEN NULL
                ELSE 
                    (COUNT(CASE WHEN TRUNC(created) = TRUNC(SYSDATE) THEN 1 END) - 
                    COUNT(CASE WHEN TRUNC(created) = TRUNC(SYSDATE - 1) THEN 1 END)) * 100.0 /
                    COUNT(CASE WHEN TRUNC(created) = TRUNC(SYSDATE - 1) THEN 1 END)
                END,
                2
            ) AS todaysChangePercent,

            -- This month's created bills
            COUNT(CASE 
                WHEN EXTRACT(YEAR FROM created) = EXTRACT(YEAR FROM SYSDATE)
                AND EXTRACT(MONTH FROM created) = EXTRACT(MONTH FROM SYSDATE)
                THEN 1 END) AS thisMonthBills,

            -- Last month's created bills
            COUNT(CASE 
                WHEN created >= TRUNC(ADD_MONTHS(SYSDATE, -1), 'MM')
                AND created < TRUNC(SYSDATE, 'MM')
                THEN 1 END) AS lastMonthBills,

            -- Percent change from last month to this month
            ROUND(
                CASE 
                WHEN COUNT(CASE 
                    WHEN created >= TRUNC(ADD_MONTHS(SYSDATE, -1), 'MM')
                    AND created < TRUNC(SYSDATE, 'MM')
                    THEN 1 END) = 0 THEN NULL
                ELSE 
                    (COUNT(CASE 
                    WHEN EXTRACT(YEAR FROM created) = EXTRACT(YEAR FROM SYSDATE)
                        AND EXTRACT(MONTH FROM created) = EXTRACT(MONTH FROM SYSDATE)
                    THEN 1 END) - 
                    COUNT(CASE 
                    WHEN created >= TRUNC(ADD_MONTHS(SYSDATE, -1), 'MM')
                        AND created < TRUNC(SYSDATE, 'MM')
                    THEN 1 END)) * 100.0 /
                    COUNT(CASE 
                    WHEN created >= TRUNC(ADD_MONTHS(SYSDATE, -1), 'MM')
                        AND created < TRUNC(SYSDATE, 'MM')
                    THEN 1 END)
                END,
                2
            ) AS thisMonthChangePercent,

            -- Count of records with non-empty transformed field
            COUNT(CASE 
                WHEN custrecord_ocr_transformed_to_bill IS NULL
                AND custrecord_ocr_bill_type IN (1, 2) 
                AND subsidiary.name IS NOT NULL
                THEN 1 
            END) AS unprocessedBills

        FROM customrecord_ocr_created_bills
        
        LEFT JOIN
            subsidiary AS subsidiary
            ON customrecord_ocr_created_bills.custrecord_ocr_bill_subsidiary = subsidiary.id
        WHERE subsidiary.name IS NOT NULL
    `;

    const aiAccuracyRateSuiteQL = `
        SELECT 
            COUNT(DISTINCT sn.id) AS changedBills,
            COUNT(DISTINCT createdBills.id) AS transformedBills,
            ROUND(
                ((COUNT(DISTINCT createdBills.id) - COUNT(DISTINCT sn.id)) * 100.0) 
                / NULLIF(COUNT(DISTINCT createdBills.id), 0),
                2
            ) AS accuracyRatePercentage
        FROM customrecord_ocr_created_bills AS createdBills
        LEFT JOIN SystemNote AS sn
            ON sn.recordId = createdBills.id
            AND BUILTIN.DF(sn.recordTypeId) = 'OCR Created Bills'
            AND sn.type = 4
            AND (sn.field = 'CUSTRECORD_OCR_BILL_VENDOR' OR sn.field = 'CUSTRECORD_OCR_BILL_PO_NUM')
        WHERE createdBills.custrecord_ocr_transformed_to_bill IS NOT NULL
    `;

    return {
        exportaiBillsStatsSuiteQL: exportaiBillsStatsSuiteQL,
        aiAccuracyRateSuiteQL:     aiAccuracyRateSuiteQL
    };
});
