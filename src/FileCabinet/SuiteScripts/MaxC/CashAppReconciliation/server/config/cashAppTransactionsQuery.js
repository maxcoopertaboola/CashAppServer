/**
 * Config/apiQueries.js
 * Contains SuiteQL queries for API actions.
 */

define([], function() {
    const exportInvoicesSuiteQL = `
      SELECT
            ct.id, 
            ct.custrecord_pri_cashapp_trans_account_no AS cash_app_transaction_account_no, 
            BUILTIN.DF(ct.custrecord_pri_cashapp_trans_matchstatus) AS cash_app_transaction_match_status, 
            ct.custrecord_pri_cashapp_trans_batch AS cash_app_transaction_batch, 
            ct.custrecord_pri_cashapp_trans_date AS cash_app_transaction_date, 
            ct.custrecord_pri_cashapp_trans_cust_name AS cash_app_transaction_customer_name, 
            ct.custrecord_pri_cashapp_trans_details AS cash_app_transaction_details, 
            ct.custrecord_pri_cashapp_trans_amount AS cash_app_transaction_amount,
            ct.custrecord_pri_cashapp_suggested_cust AS cash_app_transaction_suggested_customer_id,
            customer.fullname AS cash_app_transaction_suggested_customer_name,
            ct.custrecord_pri_cashapp_trans_foreignamt AS cash_app_transaction_foreign_amount,
            ct.custrecord_pri_cashapp_trans_foreigncur AS cash_app_transaction_foreign_currency,
            ct.custrecord_pri_cashapp_trans_exchrate AS cash_app_transaction_exchange_rate,
            ct.custrecord_tb_wht_rate AS cash_app_transaction_wht_rate,
            ct.custrecord_tb_wht_cert_no AS cash_app_transaction_wht_cert_no,
            ct.custrecord_pri_cashapp_linked_bank_acct AS cash_app_transaction_linked_bank_account_id,
            ct.custrecord_pri_cashapp_trans_bankfee AS cash_app_transaction_bank_fee,
            account.currency AS cash_app_transaction_currency_id,
            cash_app_transaction_currency.name AS cash_app_transaction_currency,
            cash_app_setup.custrecord_pri_cashapp_setup_writeoffamt AS cash_app_writeoff_threshold,
            BUILTIN.DF(cash_app_setup.custrecord_tb_wht_regime) AS cash_app_transaction_wht_regime,
            cash_app_setup.custrecord_pri_cashapp_setup_dummycust AS cash_app_transaction_dummy_customer_id,
            'invoices' AS transaction_category,
            t.id AS invoice_id,
            t.trandate AS invoice_date,
            t.tranid AS invoice_number,
            t.entity AS invoice_entity_id,
            t.type AS invoice_type,
            customer.fullname AS invoice_entity_name,
            t.currency AS invoice_currency_id,
            currency.name AS invoice_currency,
            t.custbody_stc_amount_after_discount AS invoice_subtotal,
            
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
            customrecord_pri_cashapp_transaction AS ct
        LEFT JOIN
            transaction AS t 
            ON (t.entity = ct.custrecord_pri_cashapp_suggested_cust AND t.status = 'A')
        LEFT JOIN
            customer AS customer
            ON ct.custrecord_pri_cashapp_suggested_cust = customer.id
        LEFT JOIN
            currency AS currency
            ON t.currency = currency.id
        LEFT JOIN 
            account AS account
            ON ct.custrecord_pri_cashapp_linked_bank_acct = account.id
        LEFT JOIN
            currency AS cash_app_transaction_currency
            ON account.currency = cash_app_transaction_currency.id
        LEFT JOIN
            customrecord_pri_cashapp_batch AS cash_app_batch
            ON ct.custrecord_pri_cashapp_trans_batch = cash_app_batch.id
        LEFT JOIN
            customrecord_pri_cashapp_setup AS cash_app_setup
            ON cash_app_batch.custrecord_pri_cashapp_batch_setup = cash_app_setup.id
        WHERE 
            ct.custrecord_pri_cashapp_trans_matchstatus {MATCH_STATUS_FILTER}
            AND ct.custrecord_pri_cashapp_linked_subsidiary IN (?)
            AND cash_app_batch.custrecord_pri_cashapp_batch_status = 2
            {DATE_FILTER}

        UNION ALL

        SELECT
            ct.id, 
            ct.custrecord_pri_cashapp_trans_account_no AS cash_app_transaction_account_no, 
            BUILTIN.DF(ct.custrecord_pri_cashapp_trans_matchstatus) AS cash_app_transaction_match_status, 
            ct.custrecord_pri_cashapp_trans_batch AS cash_app_transaction_batch, 
            ct.custrecord_pri_cashapp_trans_date AS cash_app_transaction_date, 
            ct.custrecord_pri_cashapp_trans_cust_name AS cash_app_transaction_customer_name, 
            ct.custrecord_pri_cashapp_trans_details AS cash_app_transaction_details, 
            ct.custrecord_pri_cashapp_trans_amount AS cash_app_transaction_amount,
            ct.custrecord_pri_cashapp_suggested_cust AS cash_app_transaction_suggested_customer_id,
            customer.fullname AS cash_app_transaction_suggested_customer_name,
            ct.custrecord_pri_cashapp_trans_foreignamt AS cash_app_transaction_foreign_amount,
            ct.custrecord_pri_cashapp_trans_foreigncur AS cash_app_transaction_foreign_currency,
            ct.custrecord_pri_cashapp_trans_exchrate AS cash_app_transaction_exchange_rate,
            ct.custrecord_tb_wht_rate AS cash_app_transaction_wht_rate,
            ct.custrecord_tb_wht_cert_no AS cash_app_transaction_wht_cert_no,
            ct.custrecord_pri_cashapp_linked_bank_acct AS cash_app_transaction_linked_bank_account_id,
            ct.custrecord_pri_cashapp_trans_bankfee AS cash_app_transaction_bank_fee,
            account.currency AS cash_app_transaction_currency_id,
            cash_app_transaction_currency.name AS cash_app_transaction_currency,
            cash_app_setup.custrecord_pri_cashapp_setup_writeoffamt AS cash_app_writeoff_threshold,
            BUILTIN.DF(cash_app_setup.custrecord_tb_wht_regime) AS cash_app_transaction_wht_regime,
            cash_app_setup.custrecord_pri_cashapp_setup_dummycust AS cash_app_transaction_dummy_customer_id,
            'payments' AS transaction_category,
            t.id AS invoice_id,
            t.trandate AS invoice_date,
            t.tranid AS invoice_number,
            t.entity AS invoice_entity_id,
            t.type AS invoice_type,
            invoice_entity_customer.fullname AS invoice_entity_name,
            t.currency AS invoice_currency_id,
            currency.name AS invoice_currency,
            t.custbody_stc_amount_after_discount AS invoice_subtotal,
            
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
            customrecord_pri_cashapp_transaction AS ct
        LEFT JOIN
            transaction AS t 
            ON t.custbody_pri_cashapp_transaction = ct.id
        LEFT JOIN
            customer AS customer
            ON ct.custrecord_pri_cashapp_suggested_cust = customer.id
        LEFT JOIN
            customer AS invoice_entity_customer
            ON t.entity = invoice_entity_customer.id
        LEFT JOIN
            currency AS currency
            ON t.currency = currency.id
        LEFT JOIN 
            account AS account
            ON ct.custrecord_pri_cashapp_linked_bank_acct = account.id
        LEFT JOIN
            currency AS cash_app_transaction_currency
            ON account.currency = cash_app_transaction_currency.id
        LEFT JOIN
            customrecord_pri_cashapp_batch AS cash_app_batch
            ON ct.custrecord_pri_cashapp_trans_batch = cash_app_batch.id
        LEFT JOIN
            customrecord_pri_cashapp_setup AS cash_app_setup
            ON cash_app_batch.custrecord_pri_cashapp_batch_setup = cash_app_setup.id
        WHERE 
            ct.custrecord_pri_cashapp_trans_matchstatus {MATCH_STATUS_FILTER}
            AND ct.custrecord_pri_cashapp_linked_subsidiary IN (?)
            AND cash_app_batch.custrecord_pri_cashapp_batch_status = 2
            {DATE_FILTER}

        UNION ALL

        SELECT
            ct.id, 
            ct.custrecord_pri_cashapp_trans_account_no AS cash_app_transaction_account_no, 
            BUILTIN.DF(ct.custrecord_pri_cashapp_trans_matchstatus) AS cash_app_transaction_match_status, 
            ct.custrecord_pri_cashapp_trans_batch AS cash_app_transaction_batch, 
            ct.custrecord_pri_cashapp_trans_date AS cash_app_transaction_date, 
            ct.custrecord_pri_cashapp_trans_cust_name AS cash_app_transaction_customer_name, 
            ct.custrecord_pri_cashapp_trans_details AS cash_app_transaction_details, 
            ct.custrecord_pri_cashapp_trans_amount AS cash_app_transaction_amount,
            ct.custrecord_pri_cashapp_suggested_cust AS cash_app_transaction_suggested_customer_id,
            customer.fullname AS cash_app_transaction_suggested_customer_name,
            ct.custrecord_pri_cashapp_trans_foreignamt AS cash_app_transaction_foreign_amount,
            ct.custrecord_pri_cashapp_trans_foreigncur AS cash_app_transaction_foreign_currency,
            ct.custrecord_pri_cashapp_trans_exchrate AS cash_app_transaction_exchange_rate,
            ct.custrecord_tb_wht_rate AS cash_app_transaction_wht_rate,
            ct.custrecord_tb_wht_cert_no AS cash_app_transaction_wht_cert_no,
            ct.custrecord_pri_cashapp_linked_bank_acct AS cash_app_transaction_linked_bank_account_id,
            ct.custrecord_pri_cashapp_trans_bankfee AS cash_app_transaction_bank_fee,
            account.currency AS cash_app_transaction_currency_id,
            cash_app_transaction_currency.name AS cash_app_transaction_currency,
            cash_app_setup.custrecord_pri_cashapp_setup_writeoffamt AS cash_app_writeoff_threshold,
            BUILTIN.DF(cash_app_setup.custrecord_tb_wht_regime) AS cash_app_transaction_wht_regime,
            cash_app_setup.custrecord_pri_cashapp_setup_dummycust AS cash_app_transaction_dummy_customer_id,
            'invoices' AS transaction_category,
            t.id AS invoice_id,
            t.trandate AS invoice_date,
            t.tranid AS invoice_number,
            t.entity AS invoice_entity_id,
            t.type AS invoice_type,
            invoice_entity_customer.fullname AS invoice_entity_name,
            t.currency AS invoice_currency_id,
            currency.name AS invoice_currency,
            t.custbody_stc_amount_after_discount AS invoice_subtotal,
            
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
            customrecord_pri_cashapp_transaction AS ct
        INNER JOIN
            transaction AS t
            ON EXISTS (
                SELECT 1
                FROM transaction AS payment
                INNER JOIN nexttransactionlinelink AS ntll ON ntll.nextdoc = payment.id
                WHERE payment.custbody_pri_cashapp_transaction = ct.id
                AND ntll.previousdoc = t.id
            )
        LEFT JOIN
            customer AS customer
            ON ct.custrecord_pri_cashapp_suggested_cust = customer.id
        LEFT JOIN
            customer AS invoice_entity_customer
            ON t.entity = invoice_entity_customer.id
        LEFT JOIN
            currency AS currency
            ON t.currency = currency.id
        LEFT JOIN 
            account AS account
            ON ct.custrecord_pri_cashapp_linked_bank_acct = account.id
        LEFT JOIN
            currency AS cash_app_transaction_currency
            ON account.currency = cash_app_transaction_currency.id
        LEFT JOIN
            customrecord_pri_cashapp_batch AS cash_app_batch
            ON ct.custrecord_pri_cashapp_trans_batch = cash_app_batch.id
        LEFT JOIN
            customrecord_pri_cashapp_setup AS cash_app_setup
            ON cash_app_batch.custrecord_pri_cashapp_batch_setup = cash_app_setup.id
        WHERE 
            ct.custrecord_pri_cashapp_trans_matchstatus {MATCH_STATUS_FILTER}
            AND ct.custrecord_pri_cashapp_linked_subsidiary IN (?)
            AND cash_app_batch.custrecord_pri_cashapp_batch_status = 2
            {DATE_FILTER}
            
    `;

    return {
        exportInvoicesSuiteQL: exportInvoicesSuiteQL
    };
});