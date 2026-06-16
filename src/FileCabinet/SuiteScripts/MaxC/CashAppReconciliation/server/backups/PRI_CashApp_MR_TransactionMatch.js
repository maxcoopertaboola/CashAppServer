//-----------------------------------------------------------------------------------------------------------
// Copyright 2024, All rights reserved, Prolecto Resources, Inc.
//
// No part of this file may be copied or used without express, written permission of Prolecto Resources, Inc.
//-----------------------------------------------------------------------------------------------------------
//-----------------------------------------------------------------------------------------------------------
// Description: Matches and auto applies Cash Application Transaction payments to open NetSuite transactions
//-----------------------------------------------------------------------------------------------------------
// Version History
// 20240328 Jeff Dennis PTM20064
// 20240815 Jeff Dennis PTM21160 - Modified to reschedule self in the event of more 
//                                 transactions needing to be processed.
// 20250926 Jeff Dennis PTM24443 - Updated for CashApp backups.
//
//-----------------------------------------------------------------------------------------------------------

/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @see https://system.netsuite.com/app/help/helpcenter.nl?fid=section_4387799161.html&whence=
 */
define([
    'N/log',
    'N/query',
    'N/record',
    'N/runtime',
    'N/search',
    './PRI_CashApp_Common',
    '/.bundle/132118/PRI_ServerLibrary21'
], function(log, suiteQL, record, runtime, search, cashApp, priLibrary) {
    const scriptName = 'PRI_CashApp_MR_TransactionProcessor'

    /* ====================================================================================================== */

    /**
     * Main entry point. Runs on scheduled or ad-hoc execution of the script.
     * @returns {Object} - The input data to process
     */
    function getInputData() {
        const fn = `${scriptName}.getInputData`
        log.debug(fn, '===============================================')
        log.audit(fn, 'START')

        if (priLibrary.anotherDeploymentIsExecuting()) {
            log.audit(`${fn}: Exiting. Another script deployement is already executing.`)
            return
        }

        const script = runtime.getCurrentScript(),
            batchId = script.getParameter({name:'custscript_pri_cashapp_filterbybatchid'}),
            reprocess = script.getParameter({name:'custscript_pri_cashapp_reproc_unmatched'}),
            modifier = script.getParameter({name:'custscript_pri_cashapp_querymodifier'})

        log.debug(`${fn} Parameters`, {batchId, reprocess, modifier})
        return getLoadData(batchId, reprocess, modifier)
    }

    function getLoadData(batchId, reprocess = false, modifier = '') {
        const fn = `${scriptName}.getLoadData`
        
        let whereClause = ' AND T.custrecord_pri_cashapp_trans_batch IS NOT NULL'
        if (!!batchId && batchId > 0) {
            whereClause = ` AND T.custrecord_pri_cashapp_trans_batch = ${batchId}`
        }
        
        if (reprocess === true || reprocess === 'true') {
            whereClause += ` AND B.custrecord_pri_cashapp_batch_status = ${cashApp.BATCH_STATUS.PROCESSED}`
            if (!!modifier) {
                log.debug(fn, {modifier})
                whereClause += modifier
            }
        } else {
            whereClause += ` AND B.custrecord_pri_cashapp_batch_status <> ${cashApp.BATCH_STATUS.PROCESSED}`
        }

        const query =`
        SELECT
            T.id,
            T.custrecord_pri_cashapp_trans_batch,
            T.custrecord_pri_cashapp_trans_data
        FROM customrecord_pri_cashapp_transaction T
        JOIN customrecord_pri_cashapp_batch B ON B.id = T.custrecord_pri_cashapp_trans_batch
        WHERE T.isinactive = 'F'
            AND T.custrecord_pri_cashapp_trans_matchstatus IN (${cashApp.MATCH_STATUS.NOT_MATCHED},${cashApp.MATCH_STATUS.REVIEW})
        ${whereClause}`

        log.debug(fn, {query:query.replace(/[\r\n]/g,'')})
        const results = suiteQL.runSuiteQL({query}).asMappedResults()
        log.audit(fn, {resultCount:results.length})
        return results
    }

    /* ====================================================================================================== */

    /**
     * Callback for each result from getInputData(). 
     * Processes customrecord_pri_cashapp_transaction records and tries to match to existing entities and transactions.
     * @param {Object} context - Map Context
     */
    function map(context) {
        const { key, value } = context,
            cashAppTransactionValues = JSON.parse(value),
            fn = `${scriptName}.map ${cashAppTransactionValues.id}`,
            //data = JSON.parse(cashAppTransactionValues.values.custrecord_pri_cashapp_trans_data),
            data = JSON.parse(cashAppTransactionValues.custrecord_pri_cashapp_trans_data),
            script = runtime.getCurrentScript(),
            reprocess = script.getParameter({name:'custscript_pri_cashapp_reproc_unmatched'})
        
        // let batch = cashAppTransactionValues?.values?.custrecord_pri_cashapp_trans_batch
        let batch = cashAppTransactionValues.custrecord_pri_cashapp_trans_batch
        if (!batch) batch = null
        log.debug(fn, {batch, data})

        const matched = cashApp.matchCashAppTransaction(cashAppTransactionValues.id, data, reprocess)
        if (matched.status === cashApp.MATCH_STATUS.REVIEW) {
            //log.debug(fn, JSON.stringify({matched}))
            context.write({key:cashAppTransactionValues.id,value:{batch,matches:matched.matches}})
        } else {
            context.write({key:cashAppTransactionValues.id,value:{batch,matches:{}}})
        }
    }

    /* ====================================================================================================== */

    /**
     * Reduces output for created PRI CashApp Transactions. 
     * If the PRI CashApp Trans it has matching native transactions, try to auto-apply the matched transactions.
     * @param {Object} context - Reduce Context
     */
    function reduce(context) {
        const { key, values } = context,
            fn = `${scriptName}.reduce ${key}`,
            script = runtime.getCurrentScript(),
            reprocess = script.getParameter({name:'custscript_pri_cashapp_reproc_unmatched'})

        log.debug(fn, `Reduce ${key} Start`)
        let matches = {}
        for (const v of values) {
            const data = JSON.parse(v)
            log.debug(fn, {data})
            for (const id in data.matches) {
                if (!matches.hasOwnProperty(id))
                    matches[id] = data.matches[id]
            }
            log.debug(`${fn} batch`, JSON.stringify(data.batch))
            context.write({key:data.batch,value:''})
        }

        cashApp.autoApplyCashAppTransaction(key, matches, reprocess)
    }

    /* ====================================================================================================== */

    /**
     * Summarizes the Map/Reduce script execution
     * @param {Object} summary - Summary Context
     */
    function summarize(summary) {
        const fn = `${scriptName}.summarize`
        const { mapSummary, reduceSummary, output } = summary,
            script = runtime.getCurrentScript()

            
        log.audit(fn, JSON.stringify(summary))
        mapSummary.errors.iterator().each((k,v) => {
            log.error(`${fn}.map: ${k}`, JSON.stringify(v))
            return true
        })
        reduceSummary.errors.iterator().each((k,v) => {
            log.error(`${fn}.reduce: ${k}`, JSON.stringify(v))
            return true
        })

        let processedBatches = []
        output.iterator().each((k,v) => {
            if (processedBatches.includes(k))
                return true
            cashApp.setBatchImportProcessed(k)
            processedBatches.push(k)
            return true
        })
        log.debug(fn, {processedBatches})

        // Penultimate step; update batch controls
        try {
            runBatchControlUpdates()
        } catch(err) {
            log.error(`${fn}.summarize: Failed to schedule Map/Reduce`, `Failed to setup Map/Reduce to update Batch Control totals. ${err.message}`)
        }

        const batchId = script.getParameter({name:'custscript_pri_cashapp_filterbybatchid'}),
            reprocess = script.getParameter({name:'custscript_pri_cashapp_reproc_unmatched'}),
            modifier = script.getParameter({name:'custscript_pri_cashapp_querymodifier'})

        // If the reprocess flag is set, we're done here.
        if (reprocess) return

        // Reschedule self if there's more to process
        const results = getLoadData(batchId, reprocess, modifier)
        if (results.length > 0) {
            log.audit(fn, 'Rescheduling self...')
            
            cashApp.triggerTransactionMatcher(script.deploymentId, {
                custscript_pri_cashapp_filterbybatchid:batchId,
                custscript_pri_cashapp_reproc_unmatched:reprocess,
                custscript_pri_cashapp_querymodifier:modifier
            })
        }

        log.audit(fn, '===============================================')
    }
    
    /* ====================================================================================================== */

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

    return { getInputData, map, reduce, summarize }
})
