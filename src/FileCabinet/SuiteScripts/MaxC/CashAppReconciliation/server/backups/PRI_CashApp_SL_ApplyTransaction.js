//-----------------------------------------------------------------------------------------------------------
// Copyright 2024, All rights reserved, Prolecto Resources, Inc.
//
// No part of this file may be copied or used without express, written permission of Prolecto Resources, Inc.
//-----------------------------------------------------------------------------------------------------------
//-----------------------------------------------------------------------------------------------------------
// Description: Suitelet to handle Overpayment write-offs
//-----------------------------------------------------------------------------------------------------------
// Version History
// 20240328 Jeff Dennis PTM20064
//
//-----------------------------------------------------------------------------------------------------------

/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope Public
 * @see https://system.netsuite.com/app/help/helpcenter.nl?fid=section_4387799600.html&whence=
 */
define([
    'N/log',
    'N/redirect',
    'N/runtime',
    'N/https',
    'N/record',
    'N/search',
    'N/query',
    './PRI_CashApp_Common',
], function(log, redirect, runtime, https, record, search, suiteQL, cashApp) {
    const scriptName = 'PRI_CashApp_SL_ApplyTransaction'

    /* ====================================================================================================== */

    /**
     * Main entry point. Handles suitelet HTTP request and response
     * @param {Object} context - Suitelet Context
     */
    function onRequest(context) {
        const fn = `${scriptName}.onRequest`,
            { request, response } = context,
            { parameters } = request
            
        if (!parameters.cashappid)
            return response.write({output:`Error: No 'cashappid' parameter id sent with request. Please go back to the PRI CashApp Transaction page and try again.`})
      
        if (parameters.writeoff_overpayment === 'T') {
            cashApp.writeOffOverpayment(parameters.cashappid)
        } else if (parameters.movebalancetocustomer === 'T') {
            cashApp.moveBalanceToCustomer(parameters.cashappid)
        } else if (parameters.movebalancetocustomerdeposit === 'T') {
            cashApp.moveBalanceToCustomerDeposit(parameters.cashappid)
        } else if (parameters.taboola_void === 'T') {
            taboolaVoid(parameters.cashappid)
        }

        log.debug(fn, `Governance Remaining after applying: ${runtime.getCurrentScript().getRemainingUsage()}`)

        // once done, redirect back to the PRI CashApp Transaction
        redirect.toRecord({
            id:parameters.cashappid,
            type:'customrecord_pri_cashapp_transaction',
        })
    }

    // Taboola Cash App Transaction - Void
    function taboolaVoid(cashAppTransactionId) {
        const fn = `${scriptName}.taboolaVoid`
        log.debug(fn, `Voiding Cash App Transaction ${cashAppTransactionId}`)
        const payments = cashApp.queryCashAppPayments(cashAppTransactionId)
        if (!!payments && payments.length > 0) {
            payments.forEach(p => {
                try {
                    const response = https.requestSuitelet({
                        scriptId:'customscript_acs_sl_void_transaction',
                        deploymentId:'customdeploy_acs_sl_void_transaction',
                        method:'GET',
                        urlParams:{ objRecID:p.id }
                    })
                    log.audit(`${fn}: Voided payment response ${p.id}`, response)
                } catch (err) {
                    log.error(fn, `Failed to void payment ${p.id}. ${err.message}`)
                }
            })
        }

        // Update the CashApp Transaction status to Eliminated
        record.submitFields({
            id:cashAppTransactionId,
            type:'customrecord_pri_cashapp_transaction',
            values:{
                custrecord_pri_cashapp_trans_matchstatus:cashApp.MATCH_STATUS.ELIMINATED,
                custrecord_pri_cashapp_trans_amount:'0'
            }
        })

        // Re-run Batch Totals script
        try {
            runBatchControlUpdates()
        } catch(er) {
            log.error(fn, `Failed to re-run Batch Totals scripts. ${er.message}`)
        }
    }

    // Updates any mismatched Batch Contorl totals
    function runBatchControlUpdates() {
        const fn = `${scriptName}.runBatchControlUpdates`

        let queries = []
        search.create({
            type:'customrecord_pri_app_setting',
            filters:[{name:'name',operator:search.Operator.STARTSWITH, values:'PRI CashApp Batch Control Totals'}],
            columns:['custrecord_pri_as_value']
        }).run().each(row => {
            queries.push(row.getValue({name:'custrecord_pri_as_value'}))
            return true
        })

        let updates = {}
        for (const q of queries) {
            const results = suiteQL.runSuiteQL({query:q}).asMappedResults()
            for (const row of results) {
                const values = {}
                for (const prop in row) {
                    if (prop === 'id' || prop === 'recordtype') continue
                    values[prop] = row[prop]
                }
                if (!updates.hasOwnProperty(row.id)) {
                    updates[row.id] = {
                        id:row.id,
                        type:row.recordtype,
                        values:{}
                    }
                }
                updates[row.id].values = {...updates[row.id].values, ...values}
            }
        }

        for (const id in updates) {
            try {
                record.submitFields(updates[id])
            } catch (err) {
                log.error(`${fn}: Failed to update batch controls`, `Batch ID: ${id}`)
            }
        }
    }

    /* ====================================================================================================== */
    
    return { onRequest, taboolaVoid}
})
