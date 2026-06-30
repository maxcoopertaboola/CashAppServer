//-----------------------------------------------------------------------------------------------------------
// Copyright 2025, All rights reserved, Prolecto Resources, Inc.
//
// No part of this file may be copied or used without express, written permission of Prolecto Resources, Inc.
//-----------------------------------------------------------------------------------------------------------
//-----------------------------------------------------------------------------------------------------------
// Description: Plugin that supports Cash Application. 
//-----------------------------------------------------------------------------------------------------------
// Version History
// 2025-12-29   Jeff Dennis   PTM26728: Initial version created
// 2026-03-11   Jeff Dennis   PTM28554: Netting Account support, Universal Date format support
//
//-----------------------------------------------------------------------------------------------------------

/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 */
define([
    'N/log',
    'N/config',
    'N/record',
    'N/search',
    'N/query',
    'N/format',
    '/.bundle/521028/PRI_CashApp_Common',
], function(log, config, record, search, suiteQL, format, cashApp) {
    const scriptName = 'TB_CashApp_Common'

    /* ====================================================================================================== */
    //#region Script Endpoints

    /**
     * Called by PRI_CashApp_Common.getCashAppTransactions
     * 
     * Used to mutate the Transactional data contained within the CashApp Batch data before the Transactional data is saved to NetSuite.
     * 
     * @param {string|number} batchId - The NetSuite internalid property of the PRI CashApp Batch record
     * @param {Object} batchData - The JSON data from the parsed batch file
     * @param {Array<Object>} transactions - The list of CashApp Transaction objects.
     * @param {Object} pluginData - Any data that is entered into in the PRI CashApp Configuration Plug-in Data field is passed here.
     * @returns {Array<Object>?} Returns an optional list of mutated CashApp Transaction objects. If no data is returned the calling method will default to using the transactions Array passed to this method.
     */
    function getCashAppTransactions(batchId, batchData, transactions, pluginData) {
        const fn = `${scriptName}.getCashAppTransactions, Batch ${batchId}`
        log.debug(fn, {transactions})

        // Generate a list of serials to check for duplicates
        const serials = transactions.map(t => cashAppCommon.getCashAppTransactionSerial(t))
        log.debug(fn, {serials})

        // Check for duplicates
        if (serials.length) {
            const filteredTransactions = filterDuplicateTransactions(serials, transactions)
            log.debug(fn, {filteredTransactions})
            return filteredTransactions
        }

        return transactions
    }

    /**
     * Called by PRI_CashApp_Common.createCashAppTransaction immediately after a new PRI CashApp Transaction record is saved.
     * 
     * @param {string|number} cashAppTransactionId - The PRI CashApp Transaction id
     * @param {Object} transactionData - The transactional JSON data from the parsed batch file
     * @param {Object} batchData - The JSON data from the parsed batch file
     * @param {Object} pluginData - Any data that is entered into in the PRI CashApp Configuration Plug-in Data field is passed here.
     */
    function newCashAppTransaction(transactionId, transactionData, batchData, pluginData) {
        const fn = `${scriptName}.newCashAppTransaction`

    }

    /**
     * Called by PRI_CashApp_Common.autoApplyCashAppTransaction
     * 
     * Used to identify and return a single transaction that will be automatically applied.
     * 
     * @param {string|number} cashAppTransactionId - The id of the cashapp transaction, used to fetch data
     * @param {number} paymentAmount - The payment amount of the transaction
     * @param {Array} sortedTransactions - An object containing key/value pairs of matched transactions, where the key is the transaction id.
     * @param {Object} pluginData - Any data that is entered into in the PRI CashApp Configuration Plug-in Data field is passed here.
     * @returns {Array<Object>?} Returns an array of matched transactions. If no data is returned the calling method will default to auto-applying the first sorted transaction object with a matching total.
     */
    function autoApplyCashAppTransaction(cashAppTransactionId, paymentAmount, sortedTransactions, pluginData) {
        const fn = `${scriptName}.autoApplyCashAppTransaction: ${cashAppTransactionId}`
        log.debug(fn, {paymentAmount, sortedTransactions})
        log.debug(fn, {pluginData})
        
        let balance = parseFloat(paymentAmount)
        let total = 0, matches = [], fuzzyMatchCount = 0

        
        let tolerance = 0
        const configId = pluginData?.configId
        if (!!configId) {
            const lookup = search.lookupFields({
                type:'customrecord_pri_cashapp_setup',
                id:configId,
                columns:['custrecord_pri_cashapp_setup_writeoffamt']
            })
            if (!!lookup?.['custrecord_pri_cashapp_setup_writeoffamt']) {
                tolerance = parseFloat(parseFloat(lookup['custrecord_pri_cashapp_setup_writeoffamt']).toFixed(2))
            }
        }
        log.debug(fn, {tolerance})

        const applyMatch = t => {
            log.debug(`${fn}: Add Match`, {transaction:t})
            const amount = parseFloat(t.unpaid.toFixed(2))
            t.apply = amount > balance ? balance : amount
            total += t.apply
            balance -= t.apply
            if (balance <= 0)  {
                balance = 0
            }
            matches.push(t)
        }

        // Add addenda matches with priorities of 1, 2, 3 (cash app matching rules (prio 100) and fuzzy match (prio 999) are not included)
        sortedTransactions
            .filter(t => [1,2,3].includes(t.priority))
            .forEach(applyMatch)

        // If no addenda matches, try a fuzzy match
        if (total === 0) {
            sortedTransactions.filter(t => t.priority === 999).forEach(t => {
                const amount = parseFloat(t.unpaid.toFixed(2))
                if (fuzzyMatchCount === 0 && (amount === balance)) {
                    applyMatch(t)
                    ++fuzzyMatchCount
                }
            })
        }
        log.debug(fn, {cashAppTransactionId,paymentAmount,applyTotal:total,matches})

        // If there is an auto-applyable match, create matching rules and return the matches
        if (parseFloat(total.toFixed(2)) >= parseFloat(paymentAmount.toFixed(2)) - tolerance
        && parseFloat(total.toFixed(2)) <= parseFloat(paymentAmount.toFixed(2)) + tolerance) {
            // log.debug(`${fn}: Auto-Apply`, JSON.stringify({cashAppTransactionId,transactions:matches}))
            log.debug(fn, `Auto-apply matches for CashApp Transaction ${cashAppTransactionId}`)
            try {
                createCashAppMatchingRules(null, cashAppTransactionId, matches[0].entity, pluginData)
            } catch (err) {
                log.error(fn, JSON.stringify({name:err.name,message:err.message}))
            }
            return matches
        }

        return []
    }

    /**
     * Called by PRI_CashApp_Common.matchCashAppTransaction. 
     * 
     * Used to create business-specific PRI CashApp Matching Rules.
     * 
     * @param {string|number} cashAppTransactionId - The id of the cashapp transaction, used to fetch data
     * @param {string|number} customerId - The customer id for whom rules will be associated
     * @param {Object} pluginData - Any data that is entered into in the PRI CashApp Configuration Plug-in Data field is passed here.
     */
    function createCashAppMatchingRules(batchId, cashAppTransactionId, customerId, pluginData) {
        const fn = `${scriptName}.createCashAppMatchingRules`
        // log.debug(fn, '*** NOT IMPLEMENTED ***')
        // Note: for each rule to define, this method should call cashAppCommon.createCashAppMatchingRule
        log.debug(fn, {batchId, cashAppTransactionId, customerId, pluginData})

        const lookup = search.lookupFields({
            id:cashAppTransactionId,
            type:'customrecord_pri_cashapp_transaction',
            columns:['custrecord_pri_cashapp_trans_cust_name', 'custrecord_pri_cashapp_trans_cust_id']
        })

        if (!!lookup['custrecord_pri_cashapp_trans_cust_name']) {
            try {
                cashAppCommon.createCashAppMatchingRule(pluginData?.configId, customerId, 'Customer Name=', lookup['custrecord_pri_cashapp_trans_cust_name'], 200)
            } catch (err) {
                log.error(fn, JSON.stringify({name:err.name,message:err.message}))
            }
        }
        // if (!!lookup['custrecord_pri_cashapp_trans_cust_id'] && lookup['custrecord_pri_cashapp_trans_cust_id'] !== '0000000000') {
        //     try {
        //         cashAppCommon.createCashAppMatchingRule(pluginData?.configId, customerId, 'Customer ID=', lookup['custrecord_pri_cashapp_trans_cust_id'], 201)
        //     } catch (err) {
        //         log.error(fn, JSON.stringify({name:err.name,message:err.message}))
        //     }
        // }
    }

    /**
     * Called by PRI_CashApp_Common.changeCashAppCustomer
     * 
     * Used to change the customer of a CashApp Transaction.
     * 
     * @param {string|number} cashAppTransactionId - The id of the cashapp transaction, used to fetch data
     * @param {string|number} customerId - The id of the customer to change the cashapp transaction to
     * @param {Object} pluginData - Any data that is entered into in the PRI CashApp Configuration Plug-in Data field is passed here.
     */
    function changeCashAppCustomer(cashAppTransactionId, customerId, pluginData) {
        const fn = `${scriptName}.changeCashAppCustomer`

        if (!customerId)
            return

        const setupId = search.lookupFields({
            type:'customrecord_pri_cashapp_transaction',
            id:cashAppTransactionId,
            columns:['custrecord_pri_cashapp_trans_batch.custrecord_pri_cashapp_batch_setup']
        })?.['custrecord_pri_cashapp_trans_batch.custrecord_pri_cashapp_batch_setup']?.[0]?.value
        let subsidiary = null
        if (!!setupId) {
            const sub = search.lookupFields({
                type:'customrecord_pri_cashapp_setup',
                id:setupId,
                columns:['custrecord_pri_cashapp_setup_subsidiary']
            })?.['custrecord_pri_cashapp_setup_subsidiary']?.[0]?.value
            if (!!sub) {
                subsidiary = sub
            }
        }

        // Get all open AR for the given customer
        const openAr = queryOpenInvoicesByEntity(customerId, subsidiary)
        if (openAr.length) {
            let matches = search.lookupFields({
                type:'customrecord_pri_cashapp_transaction',
                id:cashAppTransactionId,
                columns:['custrecord_pri_cashapp_trans_matches']
            })?.['custrecord_pri_cashapp_trans_matches']
            if (!!matches) {
                try {
                    matches = JSON.parse(matches)
                } catch(err) {
                    log.error(fn, JSON.stringify({name:err.name,message:err.message}))
                }
            } else {
                matches = {}
            }

            // Adds a transaction to the matches object
            const addMatch = (id, tran, ruleString, priority) => {
                if (matches.hasOwnProperty(id)) {
                    matches[id].priority = priority
                    if (!matches[id].rules.includes(ruleString))
                        matches[id].rules.unshift(ruleString)
                } else {
                    matches[id] = {
                        id: tran.id,
                        recordtype: tran.recordtype,
                        entity: tran.entity,
                        trandate: tran.trandate,
                        subsidiary: tran.subsidiary,
                        tranid: tran.tranid,
                        total: tran.total,
                        unpaid: tran.unpaid,
                        status: tran.status,
                        otherrefnum: tran.otherrefnum,
                        apply: tran.apply,
                        priority: priority,
                        rules: [ruleString],
                        backup: tran?.backup_line_id
                    }
                }
            }
            // Add matches to the Cash App Transaction
            for (const match of openAr) {
                addMatch(match.id, match, `Taboola Customer Match'`, 3)
            }

            try {
                record.submitFields({
                    type:'customrecord_pri_cashapp_transaction',
                    id:cashAppTransactionId,
                    values:{custrecord_pri_cashapp_trans_matches:JSON.stringify(matches)}
                })
            } catch(err) {
                log.error(fn, JSON.stringify({name:err.name,message:err.message}))
            }
        }
    }

    function filterDuplicateTransactions(serials, transactions) {
        const fn = `${scriptName}.filterDuplicateTransactions`
        const matchedSerials = suiteQL.runSuiteQL({query:
            `SELECT custrecord_pri_cashapp_trans_serial serial
            FROM customrecord_pri_cashapp_transaction
            WHERE custrecord_pri_cashapp_trans_serial IN (${serials.map(s => `'${s}'`).join(',')})`
        }).asMappedResults().map(r => r.serial)
        log.debug(fn, {matchCount: matchedSerials.length, matchedSerials})
        if (!matchedSerials.length) {
            return transactions
        }
        
        // Filter out the duplicates & return
        const nonDuplicateTransactions = transactions.filter(t => !matchedSerials.includes(cashAppCommon.getCashAppTransactionSerial(t)))
        log.debug(fn, {nonDuplicateCount: nonDuplicateTransactions.length, nonDuplicateTransactions})
        return nonDuplicateTransactions
    }

    function getAddendaDetails(details, pluginData) {
        const fn = `${scriptName}.getAddendaDetails`
        // log.debug(fn, {type: typeof details, details})
        // log.debug(fn, {pluginData})

        const getAddendaString = d => {
            if (!d || !d?.details) return null
            let addenda = Array.isArray(d.details) 
                ? d.details[0]?.memo
                : d.details?.memo
            if (!addenda) return null
            return addenda
        }

        let addenda = getAddendaString(details)
        // log.debug(fn, {addenda:addenda??null})

        // Details array
        const d = []
        const ids = []

        // Repeating Addenda patterns are matched to Invoice Number or Invoice Reference Number
        if (!!pluginData && Array.isArray(pluginData.addenda_match_patterns)) {
            // log.debug(fn, `${pluginData.addenda_match_patterns.length} Addenda MATCH patterns found`)
            for (const regexStr of pluginData.addenda_match_patterns) {
                const regex = new RegExp(regexStr, 'gi'),
                    results = [...addenda.matchAll(regex)]?.[0]
                log.debug(fn, {regexStr, results})
                if (results?.length > 1) {
                    const id = results[1]
                    if (!ids.includes(id)) ids.push(id)
                    else continue

                    if (results.length === 2) {
                        d.push({match:results[0], number:id})
                    } else if (results.length === 3) {
                        let amount = null
                        try {
                            // Convert the amount that is formatted as "123456 23 " to 123456.23
                            amount = parseFloat(results[2].trim().replace(/\s/g, '.'))
                        } catch (err) {
                            log.debug(fn, {err})
                        }
                        d.push({match:results[0], number:id, amount:amount||undefined})
                    }
                }
            }
        } else {
            // log.debug(fn, 'No Addenda MATCH patterns found')
        }

        // Repeating Addenda patterns are only matched to Invoice Number
        if (!!pluginData && Array.isArray(pluginData.addenda_repeat_patterns)) {
            log.debug(fn, `${pluginData.addenda_repeat_patterns.length} Addenda REPEAT patterns found`)
            for (const obj of pluginData.addenda_repeat_patterns) {
                const qualifier = new RegExp(obj.qualifier, 'gi')
                const results = [...addenda.matchAll(qualifier)]
                if (!results.length) continue
                const match = results[0][0],
                    repeater = new RegExp(obj.repeater, 'gi'),
                    matches = [...match.matchAll(repeater)]
                // log.audit(`${fn}: Addenda REPEAT Pattern Match`, JSON.stringify({qualifier:obj.qualifier,match,repeater:obj.repeater,matches}))
                for (const m of matches) {
                    if (!m[1]) continue
                    // log.audit(`${fn}: Addenda REPEAT patterns match`, JSON.stringify(m))
                    d.push({match, number:m[1]})
                }
            }
        } else {
            // log.debug(fn, 'No Addenda REPEAT patterns found')
        }

        // Reset the addenda string to the original details
        addenda = getAddendaString(details)
        // log.debug(fn, {addenda})
        if (!!pluginData?.addenda_matchingrule_patterns && Object.keys(pluginData.addenda_matchingrule_patterns).length) {
            for (const backupMatchingRuleKey in pluginData.addenda_matchingrule_patterns) {
                log.debug(fn, {backupMatchingRuleKey})
                const patterns = pluginData.addenda_matchingrule_patterns[backupMatchingRuleKey]
                const aliases = pluginData.addenda_backupline_aliases[backupMatchingRuleKey]
                for (const pattern of patterns) {
                    const regex = new RegExp(pattern, 'gi'),
                        results = [...addenda.matchAll(regex)]
                    log.debug(fn, {pattern, results:results.length})
                    for (const result of results) {
                        d.push({match:result[0], backupMatchingRuleKey, aliases, matchingRuleValue:result[1], amount:result[2]||null})
                    }
                }
            }
        } else {
            // log.debug(fn, 'No Addenda MATCHING RULE patterns found')
        }

        // log.debug(fn, {d:d.length})
        return d
    }

    function queryInvoicesById(ids, subsidiary = null, unpaidOnly = true) {
        const fn = `${scriptName}.queryInvoicesById`
        if (!ids || !ids.length)
            return []
        let idsStr = ''
        for (const [i,id] of ids.entries()) {
            if (i>0) idsStr += ', '
            idsStr += `'${id}'`
        }
        if (!!subsidiary) {
            subsidiary = `= ${subsidiary}`
        } else {
            subsidiary = 'IS NOT NULL'
        }
        return suiteQL.runSuiteQL({query:`
            SELECT 
                t.id,
                t.recordtype,
                t.entity,
                BUILTIN.DF(t.entity) as entityname,
                t.trandate,
                t.tranid,
                t.currency,
                BUILTIN.DF(t.currency) as currencyname,
                t.exchangerate,
                t.foreignTotal as total,
                t.foreignAmountUnpaid as unpaid,
                NVL(ABS(txl.foreignAmount), 0) taxamount,
                (t.foreignTotal - NVL(ABS(txl.foreignAmount), 0)) totalnetoftax,
                t.status,
                BUILTIN.DF(t.status) as statuslabel,
                t.otherrefnum,
                tl.subsidiary
            FROM transaction as t
            JOIN transactionline as tl ON tl.transaction = t.id AND tl.mainline = 'T'
            LEFT JOIN transactionline as txl ON txl.transaction = t.id AND txl.taxtype IS NOT NULL
            WHERE t.recordtype = 'invoice'
                AND tl.subsidiary ${subsidiary}
                AND t.tranid IN (${idsStr})
                ${unpaidOnly ? 'AND t.foreignAmountUnpaid > 0' : ''}
        `}).asMappedResults()
    }

    function queryInvoicesByAmount(amount = 0, subsidiary = null) {
        const fn = `${scriptName}.queryInvoicesByAmount`
        if (!amount || isNaN(amount))
            return []
        if (!!subsidiary) {
            subsidiary = `= ${subsidiary}`
        } else {
            subsidiary = 'IS NOT NULL'
        }
        return suiteQL.runSuiteQL({query:`
            SELECT 
                t.id,
                t.recordtype,
                t.entity,
                BUILTIN.DF(t.entity) as entityname,
                t.trandate,
                t.tranid,
                t.currency,
                BUILTIN.DF(t.currency) as currencyname,
                t.exchangerate,
                t.foreignTotal as total,
                t.foreignAmountUnpaid as unpaid,
                NVL(ABS(txl.foreignAmount), 0) taxamount,
                (t.foreignTotal - NVL(ABS(txl.foreignAmount), 0)) totalnetoftax,
                t.status,
                BUILTIN.DF(t.status) as statuslabel,
                t.otherrefnum,
                tl.subsidiary
            FROM transaction as t
            JOIN transactionline as tl ON tl.transaction = t.id AND tl.mainline = 'T'
            LEFT JOIN transactionline as txl ON txl.transaction = t.id AND txl.taxtype IS NOT NULL
            WHERE t.recordtype = 'invoice'
                AND tl.subsidiary ${subsidiary}
                AND t.foreignTotal = ${amount}
                AND t.foreignAmountUnpaid > 0
        `}).asMappedResults()
    }

    function queryInvoicesByRefNo(refs, subsidiary = null) {
        const fn = `${scriptName}.queryInvoicesByRefNo`
        if (!refs || !refs.length)
            return []
        let subquery = ''
        for (const [i,ref] of refs.entries()) {
            if (i>0) subquery += ' OR '
            subquery += `t.otherrefnum LIKE '${ref}%'`
        }
        if (!!subsidiary) {
            subquery += ` AND tl.subsidiary = ${subsidiary}`
        } else {
            subquery += ' AND tl.subsidiary IS NOT NULL'
        }
        const results = suiteQL.runSuiteQL({query:`
            SELECT 
                t.id,
                t.recordtype,
                t.entity,
                BUILTIN.DF(t.entity) as entityname,
                t.trandate,
                t.tranid,
                t.currency,
                BUILTIN.DF(t.currency) as currencyname,
                t.exchangerate,
                t.foreignTotal as total,
                t.foreignAmountUnpaid as unpaid,
                NVL(ABS(txl.foreignAmount), 0) taxamount,
                (t.foreignTotal - NVL(ABS(txl.foreignAmount), 0)) totalnetoftax,
                t.status,
                BUILTIN.DF(t.status) as statuslabel,
                t.otherrefnum,
                tl.subsidiary
            FROM transaction as t
            JOIN transactionline as tl ON tl.transaction = t.id AND tl.mainline = 'T'
            LEFT JOIN transactionline as txl ON txl.transaction = t.id AND txl.taxtype IS NOT NULL
            WHERE t.recordtype = 'invoice'
            AND (${subquery})
        `}).asMappedResults()
        log.debug(fn, `${results.length} results`)
        return results
    }  

    function queryOpenInvoicesByEntity(entity, subsidiary = null) {
        const fn = `${scriptName}.queryOpenInvoicesByEntity`
        if (!entity)
            return []
        if (!!subsidiary) {
            subsidiary = `= ${subsidiary}`
        } else {
            subsidiary = 'IS NOT NULL'
        }
        return suiteQL.runSuiteQL({query:`
            SELECT 
                t.id,
                t.recordtype,
                t.entity,
                BUILTIN.DF(t.entity) as entityname,
                t.trandate,
                t.tranid,
                t.currency,
                BUILTIN.DF(t.currency) as currencyname,
                t.exchangerate,
                t.foreignTotal as total,
                t.foreignAmountUnpaid as unpaid,
                NVL(ABS(txl.foreignAmount), 0) taxamount,
                (t.foreignTotal - NVL(ABS(txl.foreignAmount), 0)) totalnetoftax,
                t.status,
                BUILTIN.DF(t.status) as statuslabel,
                t.otherrefnum,
                tl.subsidiary
            FROM transaction as t
            JOIN transactionline as tl ON tl.transaction = t.id AND tl.mainline = 'T'
            LEFT JOIN transactionline as txl ON txl.transaction = t.id AND txl.taxtype IS NOT NULL
            WHERE t.recordtype = 'invoice'
                AND tl.subsidiary ${subsidiary}
                AND t.entity = ${entity}
                AND t.foreignAmountUnpaid > 0
        `}).asMappedResults()
    }

    function queryOpenTransactionsByClientName(names = [], subsidiary = null) {
        const fn = `${scriptName}.queryOpenTransactionsByClientName`
        if (!names || !names.length)
            return []
        log.debug(fn, {names})
        let subquery = ''
        for (const [i,name] of names.entries()) {
            if (!name) continue
            if (i>0) subquery += ' OR '
            let _name = name.replace(/\'/g, "").toLowerCase().trim()
            subquery += `lower(c.entitytitle) LIKE '%${_name}%'`
        }
        if (!!subsidiary) {
            subquery += ` AND l.subsidiary = ${subsidiary}`
        } else {
            subquery += ' AND l.subsidiary IS NOT NULL'
        }
        let q =
            `SELECT
                t.id,
                t.recordtype,
                t.entity,
                BUILTIN.DF(t.entity) as entityname,
                t.trandate,
                t.tranid,
                t.currency,
                BUILTIN.DF(t.currency) as currencyname,
                t.exchangerate,
                t.foreignTotal as total,
                t.foreignAmountUnpaid as unpaid,
                NVL(ABS(txl.foreignAmount), 0) taxamount,
                (t.foreignTotal - NVL(ABS(txl.foreignAmount), 0)) totalnetoftax,
                t.status,
                BUILTIN.DF(t.status) as statuslabel,
                t.otherrefnum,
                l.subsidiary,
                t.billingstatus
            FROM transaction as t
            JOIN transactionline as l ON l.transaction = t.id AND l.mainline = 'T'
            LEFT JOIN transactionline as txl ON txl.transaction = t.id AND txl.taxtype IS NOT NULL
            JOIN customer as c
                ON c.id = t.entity
            WHERE t.recordtype = 'invoice'
                AND t.billingstatus = 'T'
                AND (${subquery})`
        const results = suiteQL.runSuiteQL({query:q}).asMappedResults()
        const filtered = results.filter(r => r.billingstatus === 'T')
        log.debug(fn, {results:results.length, openCount:filtered.length})
        return filtered
    }

    function createWriteOffJE(batchId, cashAppTranId, date, subsidiary, customer, amount, debitAcct, creditAcct, memo, location, type, currency, invoice) {
        const fn = `${scriptName}.createWriteOffJE`

        // Copy the Customer ID from the Cash App Transaction to the memo
        const lookup = search.lookupFields({
            id:cashAppTranId,
            type:'customrecord_pri_cashapp_transaction',
            columns:['custrecord_pri_cashapp_trans_cust_id']
        })
        if (!!lookup?.['custrecord_pri_cashapp_trans_cust_id']) {
            memo = lookup['custrecord_pri_cashapp_trans_cust_id']
        }
        if (!!invoice) {
            const lookup = search.lookupFields({
                id:invoice,
                type:'transaction',
                columns:['account']
            })
            if (!!lookup?.['account']) {
                creditAcct = lookup['account']?.[0]?.value
            }
        }
        log.debug(fn, {date, debitAcct, creditAcct, invoice, memo})

        const je = record.create({type:'journalentry'}),
            sublistId = 'line'

        je.setValue({fieldId:'subsidiary',value:subsidiary})
        je.setValue({fieldId:'trandate',value:formatDate(date)})
        je.setValue({fieldId:'approved',value:true})
        je.setValue({fieldId:'approvalstatus', value:2})
        je.setValue({fieldId:'custbody_pri_cashapp_batch',value:batchId})
        je.setValue({fieldId:'custbody_pri_cashapp_transaction',value:cashAppTranId})
        if (!!memo)
            je.setValue({fieldId:'memo',value:memo})
        if (!!currency)
            je.setValue({fieldId:'currency',value:currency})

        // debit
        je.setSublistValue({line:0,sublistId,fieldId:'account',value:debitAcct})
        je.setSublistValue({line:0,sublistId,fieldId:'debit',value:amount})
        je.setSublistValue({line:0,sublistId,fieldId:'entity',value:customer})
        if (!!customer)
            je.setSublistValue({line:1,sublistId,fieldId:'entity',value:customer})
        je.setSublistValue({line:0,sublistId,fieldId:'memo',value:memo})
        if (!!location)
            je.setSublistValue({line:0,sublistId,fieldId:'location',value:location})

        // credit
        je.setSublistValue({line:1,sublistId,fieldId:'account',value:creditAcct})
        je.setSublistValue({line:1,sublistId,fieldId:'credit',value:amount})
        if (!!customer)
            je.setSublistValue({line:1,sublistId,fieldId:'entity',value:customer})
        je.setSublistValue({line:1,sublistId,fieldId:'memo',value:memo})
        if (!!location)
            je.setSublistValue({line:1,sublistId,fieldId:'location',value:location})

        je.setValue({fieldId:'custbody_pri_cashapp_overpymtwriteoff',value:type=='overpayment'})
        je.setValue({fieldId:'custbody_pri_cashapp_writeofftype',value:type})

        const jeId = je.save({ignoreMandatoryFields:true})
        log.audit(fn, `Journal Entry ${jeId} created.`)

        return jeId
    }

    function addCashAppMatch(matches, id, tran, ruleString, priority, increment = false, incrementAmount = 0, referenceAmount) {
        if (matches.hasOwnProperty(id)) {
            matches[id].priority = priority
            if (increment) 
                matches[id].apply += (parseFloat(incrementAmount||0)*100)/100
            else 
                matches[id].apply = tran.apply
            if (!matches[id].rules.includes(ruleString))
                matches[id].rules.unshift(ruleString)
        } else {
            matches[id] = {
                id: tran.id,
                recordtype: tran.recordtype,
                entity: tran.entity,
                trandate: tran.trandate,
                subsidiary: tran.subsidiary,
                tranid: tran.tranid,
                total: tran.total,
                unpaid: tran.unpaid,
                status: tran.status,
                otherrefnum: tran.otherrefnum,
                apply: tran.apply,
                priority: priority,
                rules: [ruleString],
                backup: tran?.backup_line_id,
                billcountry: tran?.billcountry,
                taxamount: tran?.taxamount,
                totalnetoftax: tran?.totalnetoftax ?? tran.total
            }
        }
        if (referenceAmount && !isNaN(parseFloat(referenceAmount)))
            matches[id].refAmt = (parseFloat(referenceAmount||0)*100)/100
    }

    // @deprecated (Bank transfers do not work)
    function createCurrencyNettingPayment(batchId, cashAppTranId, fields, matches, pluginData) {
        const fn = `${scriptName}.createCurrencyNettingPayment`,
            { date, subsidiary:sub, customer, location, amount:amt, paymentAmount, paymentMethod, memo, checkNumber = '', invoice = '',
                exchangeRate = 1, foreignRemitAmount = null,
            } = fields
        log.debug(fn, {batchId, cashAppTranId, fields, matches, pluginData})

        const setup = pluginData?.setup

        // const setupLookup = cashApp.lookupCashAppSetupByBatch(batchId)
        // const { defaultCurrency } = setupLookup

        let subCurrency = null, cashAccountCurrency = null
        if (!!setup?.cashAccount && !!setup?.defaultSubsidiary) {
            const subCurrSearchObj = {
                type:'subsidiary',
                id:setup?.defaultSubsidiary,
                columns:['currency']
            }
            const acctCurrSearchObj = {
                type:'account',
                id:setup?.cashAccount,
                columns:['custrecord_thl_account_currency']
            }
            log.debug(fn, {subCurrSearchObj, acctCurrSearchObj})
            subCurrency = search.lookupFields(subCurrSearchObj)?.currency?.[0]?.value
            cashAccountCurrency = search.lookupFields(acctCurrSearchObj)?.currency?.[0]?.value
            log.debug(fn, {subCurrency, cashAccountCurrency})
            const mismatches = Object.values(matches).filter(m => m.apply > 0 && String(m.currency) !== String(subCurrency) 
                && String(m.currency) !== String(cashAccountCurrency)).map(m => ({...m, nettingAccount:pluginData?.netting_accounts?.[m.currency]}))
            log.debug(fn, {mismatches})
            if (mismatches.length > 0 && !!mismatches[0]?.nettingAccount?.account) {
                // All mismatches will have the same currency, netting account and subsidiary
                const currency = mismatches[0].currency
                const subsidiary = mismatches[0].subsidiary
                const nettingAccount = mismatches[0]?.nettingAccount?.account
                if (!nettingAccount || !subsidiary) {
                    log.error(fn, {mismatches})
                    throw new Error(`${fn}: No netting account found and/or subsidiary found`)
                }
                const cashAccount = pluginData?.setup?.cashAccount
                if (!cashAccount) {
                    log.error(fn, {pluginData})
                    throw new Error(`${fn}: No cash account found`)
                }

                let amount = 0
                mismatches.forEach(m => { amount += m.apply })
            
                // Create a Bank Transfer for the Payment
                const rec = record.create({type:'transfer'})
                rec.setValue({fieldId:'fromaccount',value:nettingAccount})
                rec.setValue({fieldId:'toaccount',value:cashAccount})
                rec.setValue({fieldId:'trandate',value:formatDate(date)})

                rec.setValue({fieldId:'fromamount', value:amount})
                rec.setValue({fieldId:'toamount', value:amount})

                rec.setValue({fieldId:'memo', value:memo})
                
                rec.setValue({fieldId:'custbody_pri_cashapp_batch', value:batchId})
                rec.setValue({fieldId:'custbody_pri_cashapp_transaction', value:cashAppTranId})
                const id = rec.save({ignoreMandatoryFields:true})
                log.audit(fn, `Bank Transfer ${id} created.`)
                return [id, nettingAccount]

                //     // Create Journal Entry for each Netting Account, summed up by each mismatch.apply amount
                //     const je = record.create({type:'journalentry'}),
                //         sublistId = 'line'
    
                //     je.setValue({fieldId:'subsidiary',value:subsidiary})
                //     je.setValue({fieldId:'trandate',value:formatDate(date)})
                //     je.setValue({fieldId:'approved',value:true})
                //     je.setValue({fieldId:'approvalstatus', value:2})
                //     je.setValue({fieldId:'custbody_pri_cashapp_batch',value:batchId})
                //     je.setValue({fieldId:'custbody_pri_cashapp_transaction',value:cashAppTranId})
                //     je.setValue({fieldId:'currency',value:currency})
                //     if (!!exchangeRate) {
                //         je.setValue({fieldId:'exchangerate',value:exchangeRate})
                //         je.setValue({fieldId:'custbody_tb_exchange_rate',value:exchangeRate})
                //     }
                //     if (!!memo)
                //         je.setValue({fieldId:'memo',value:memo})
    
                //     // credit
                //     je.setSublistValue({line:1,sublistId,fieldId:'account',value:nettingAccount})
                //     je.setSublistValue({line:1,sublistId,fieldId:'credit',value:amount})
                //     if (!!customer)
                //         je.setSublistValue({line:1,sublistId,fieldId:'entity',value:customer})
                //     je.setSublistValue({line:1,sublistId,fieldId:'memo',value:memo})
                //     if (!!location)
                //         je.setSublistValue({line:1,sublistId,fieldId:'location',value:location})
    
                //     // debit
                //     je.setSublistValue({line:0,sublistId,fieldId:'account',value:cashAccount})
                //     je.setSublistValue({line:0,sublistId,fieldId:'debit',value:amount})
                //     je.setSublistValue({line:0,sublistId,fieldId:'entity',value:customer})
                //     if (!!customer)
                //         je.setSublistValue({line:1,sublistId,fieldId:'entity',value:customer})
                //     je.setSublistValue({line:0,sublistId,fieldId:'memo',value:memo})
                //     if (!!location)
                //         je.setSublistValue({line:0,sublistId,fieldId:'location',value:location})
    
                //     je.setValue({fieldId:'custbody_pri_cashapp_overpymtwriteoff',value:false})
                //     je.setValue({fieldId:'custbody_pri_cashapp_writeofftype',value:'currencynetting'})
    
                //     const jeId = je.save({ignoreMandatoryFields:true})
                //     log.audit(fn, `Journal Entry ${jeId} created.`)
            }
        }
        return [null, null]
    }

    /**
     * Whether the bank's Cash App Setup record allows auto-creating a Customer
     * Deposit (instead of a Customer Payment) when a customer's
     * `custentitytb_actual_pay_term` flags them as a prepayment customer.
     *
     * Driven by the checkbox `custrecord_tb_auto_create_prepay_deposit` on
     * `customrecord_pri_cashapp_setup`. When the field is unchecked (default
     * for legacy setups) the plugin must fall back to the standard Customer
     * Payment flow so the MR script does not silently create deposits.
     *
     * @param {Object} pluginData - The pluginData object received in plugin hooks.
     *   Expected to contain `configId` (the setup record id), which is set by
     *   PRI_CashApp_Common.getPlugin.
     * @returns {boolean} `true` only when the setup record has the field
     *   explicitly checked. Returns `false` on any lookup failure so we err on
     *   the side of NOT auto-creating deposits.
     */
    function shouldAutoCreatePrepayDeposit(pluginData) {
        const fn = `${scriptName}.shouldAutoCreatePrepayDeposit`
        const configId = pluginData?.configId
        if (!configId) {
            log.debug(fn, 'No configId on pluginData; defaulting to false')
            return false
        }
        try {
            const lookup = search.lookupFields({
                type: 'customrecord_pri_cashapp_setup',
                id: configId,
                columns: ['custrecord_tb_auto_create_prepay_deposit']
            })
            const raw = lookup?.custrecord_tb_auto_create_prepay_deposit
            const enabled = raw === true || raw === 'T' || raw === 't' || raw === '1' || raw === 1
            log.debug(fn, { configId, raw, enabled })
            return enabled
        } catch (err) {
            log.error(fn, `Failed to read custrecord_tb_auto_create_prepay_deposit on setup ${configId}. ${err.message}`)
            return false
        }
    }

    function createCustomerDeposit(batchId, cashAppTranId, fields, pluginData) {
        const fn = `${scriptName}.createCustomerDeposit`,
            { date, subsidiary, customer, location, amount = 0, paymentMethod, memo, checkNumber = '', invoice = '' } = fields

        const setup = pluginData?.setup

        const rec = record.create({type:'customerdeposit', isDynamic:true})
        rec.setValue('customer', customer)
        rec.setValue('subsidiary', subsidiary)
        rec.setValue('trandate', formatDate(date))
        rec.setValue('memo', memo)
        rec.setValue('custbody_pri_cashapp_transaction', cashAppTranId)
        rec.setValue('custbody_pri_cashapp_batch', batchId)
        if (!setup?.undepositedFunds && !!setup?.cashAccount) {
            rec.setValue({fieldId:'undepfunds',value:'F'})
            rec.setValue({fieldId:'account',value:setup?.cashAccount})
        } else {
            rec.setValue({fieldId:'undepfunds',value:'T'})
        }
        if (!!location)
            rec.setValue('location', location)
        else if (!!setup?.defaultLocation)
            rec.setValue('location', setup?.defaultLocation)

        if (!!setup?.paymentMethod) {
            rec.setValue('paymentmethod', setup?.paymentMethod?.value || setup?.paymentMethod)
        } else if (!!setup?.defaultPaymentMethod) {
            rec.setValue('paymentmethod', setup?.defaultPaymentMethod)
        }
        if (!!checkNumber && checkNumber !== '')
            rec.setValue({fieldId:'checknum',value:checkNumber})

        rec.setValue('currency', setup?.defaultCurrency)
        rec.setValue('payment', amount)

        if (fields.customMemo)
            rec.setValue({fieldId: 'custbody_tb_custom_memo', value: truncateMemo(fields.customMemo)})

        depositId = rec.save()
        log.debug(fn, `Customer deposit ${depositId} created.`)
        return depositId
    }

    //#region WHT Payments

    function createIndiaWHTPayment(batchId, cashAppTranId, fields, whtMatches, pluginData) {
        const fn = `${scriptName}.createIndiaWHTPayment`,
            type = 'customerpayment',
            { date, subsidiary, customer, location, amount = 0, paymentMethod, memo, checkNumber = '', 
                currency = null, exchangeRate = 1, foreignRemitAmount = null, foreignCurrency
            } = fields
        log.debug(fn, {batchId, cashAppTranId, fields, whtMatches, pluginData})

        const setup = cashApp.lookupCashAppSetupByBatch(batchId)
        const { defaultCurrency } = setup

        const pymt = record.create({type, isDynamic:true}),
            // method to apply a line on a dynamic customerpayment
            setLine = (sublistId, line, data) => {
                pymt.selectLine({ sublistId, line })
                pymt.setCurrentSublistValue({ sublistId, fieldId:'apply', value:true })
                pymt.setCurrentSublistValue({ sublistId, fieldId:'amount', value:data.apply })
                pymt.commitLine({ sublistId })
            }
        log.debug(fn, `Creating India WHT payment...`)

        log.debug(fn, `Setting customer to ${customer}`)
        pymt.setValue({fieldId:'customer',value:customer})

        // Set fields
        if (!!subsidiary)
            pymt.setValue({fieldId:'subsidiary',value:subsidiary})
        else if (!!setup.defaultSubsidiary)
            pymt.setValue({fieldId:'subsidiary',value:setup.defaultSubsidiary})

        // Taboola Cash App Transaction - Editable Exchange Rate
        if (!!currency)
            pymt.setValue({fieldId:'currency',value:currency})
        else if (!!defaultCurrency)
            pymt.setValue({fieldId:'currency',value:defaultCurrency})

        pymt.setValue({fieldId:'custbody_pri_cashapp_batch',value:batchId})
        pymt.setValue({fieldId:'custbody_pri_cashapp_transaction',value:cashAppTranId})
        const dt = formatDate(date)
        pymt.setValue({fieldId:'trandate',value:dt})
        pymt.setValue({fieldId:'autoapply',value:false})

        if (memo)
            pymt.setValue({fieldId:'memo',value:memo})
        if (!!location)
            pymt.setValue({fieldId:'location',value:location})
        else if (!!setup.defaultLocation)
            pymt.setValue({fieldId:'location',value:setup.defaultLocation})

        if (!!fields.arAccount)
            pymt.setValue({fieldId:'aracct',value:fields.arAccount})
        else if (!!setup.arAccount)
            pymt.setValue({fieldId:'aracct',value:setup.arAccount})

        if (!!paymentMethod) {
            const value = paymentMethod instanceof Object && paymentMethod?.value||paymentMethod
            pymt.setValue({fieldId:'paymentmethod', value, ignoreFieldChange:true})
            log.audit(fn, `Payment method set to value ${value}`)
        }
        else if (!!setup.paymentMethod) {
            const value = setup.paymentMethod instanceof Object && setup.paymentMethod?.value||setup.paymentMethod
            pymt.setValue({fieldId:'paymentmethod', value, ignoreFieldChange:true})
            log.audit(fn, `Payment method set to setup value ${value}`)
        }

        if (!!checkNumber && checkNumber !== '')
            pymt.setValue({fieldId:'checknum',value:checkNumber})

        if (!!fields?.cashAccount) {
            try {
                pymt.setValue({fieldId:'undepfunds',value:'F'})
                pymt.setValue({fieldId:'account',value:fields.cashAccount})
            } catch (err) {
                log.error(fn, `Failed to set Payment account. ${err.message}. ${err.stack}`)
                pymt.setValue({fieldId:'undepfunds',value:'T'})
                pymt.setValue({fieldId:'account',value:''})
            }
        } else if (!setup.undepositedFunds && !!setup.cashAccount) {
            try {
                pymt.setValue({fieldId:'undepfunds',value:'F'})
                pymt.setValue({fieldId:'account',value:setup.cashAccount})
            } catch (err) {
                log.error(fn, `Failed to set Payment account. ${err.message}. ${err.stack}`)
                pymt.setValue({fieldId:'undepfunds',value:'T'})
                pymt.setValue({fieldId:'account',value:''})
            }
        } else {
            pymt.setValue({fieldId:'undepfunds',value:'T'})
        }

        let applyTotal = 0
        if (!!whtMatches && Object.keys(whtMatches).length > 0) {
            const sublistId = 'apply'
            for (const id in whtMatches) {
                const line = pymt.findSublistLineWithValue({ sublistId, fieldId:'internalid', value:parseInt(id) })
                if (line === -1) {
                    log.error(`${fn}: Cannot find specified matching transaction to apply payment`,
                        JSON.stringify({id, match:whtMatches[id]}))
                    // 2024-10-18: Add retry logic for overpayment writeoffs in the event of a match not being found
                    if (whtMatches[id]?.type == 'overpayment') {
                        log.debug(fn, 'Failed to find matching transaction for overpayment writeoff.')
                        // return createPayment(batchId, cashAppTranId, fields, whtMatches, credits, true)
                    }
                    continue
                }
                const due = pymt.getSublistValue({ sublistId, line, fieldId:'due' })
                if (whtMatches[id].apply > due) {
                    log.debug(fn, `Adjusting match ${id} apply amount ${whtMatches[id].apply} to ${due} due to overpayment`)
                    whtMatches[id].apply = due
                }
                const lnApply = Math.abs(whtMatches[id].apply)
                applyTotal += lnApply
                setLine(sublistId, line, { apply:lnApply })
                log.debug(fn, `Applying ${lnApply} from transaction ${id} to payment...`)
            }
        }

        if (applyTotal == 0 && amount > 0) {
            // Taboola Cash App Transaction - Editable Exchange Rate
            if (!foreignCurrency) {
                pymt.setValue({fieldId:'payment', value:amount})
            } else {
                pymt.setValue({fieldId:'payment', value:foreignRemitAmount || amount})
            }
        }

        pymt.setValue({fieldId:'custbody_pri_cashapp_writeofftype', value:'India WHT Tax Payment'})

        const pymtId = pymt.save({ignoreMandatoryFields:true})
        log.audit(fn, `India WHT payment ${pymtId} created.`)
        return pymtId
    }

    /**
     * Returns April 1 of the current Indian fiscal year as a JS Date at 00:00 local.
     * Indian FY runs 01.04.YYYY – 31.03.YYYY+1; the boundary is keyed to today's
     * system date per requirement (not to the payment or invoice date).
     *
     * @param {Date} [now=new Date()] Override for testing.
     * @returns {Date}
     */
    function getCurrentIndianFYStart(now) {
        const today = now instanceof Date ? now : new Date()
        const year = today.getFullYear()
        // Month is 0-indexed; April === 3
        const fyYear = today.getMonth() >= 3 ? year : year - 1
        return new Date(fyYear, 3, 1, 0, 0, 0, 0)
    }

    /**
     * Parses a NetSuite trandate string (formatted per company/user preferences)
     * into a Date. Returns null if the value cannot be parsed.
     *
     * @param {string|Date|null} value
     * @returns {Date|null}
     */
    function parseTrandate(value) {
        if (!value) return null
        if (value instanceof Date) return value
        try {
            const dt = format.parse({ value: value, type: format.Type.DATE })
            return dt instanceof Date ? dt : null
        } catch (_) {
            return null
        }
    }

    /**
     * Applies the India WHT rounding rule engine to a single match and returns
     * the calculated apply amount for the WHT payment. Mirrors the per-invoice
     * algorithm previously inlined in each bank plugin.
     *
     * @param {Object} match
     * @param {number} whtRate Percentage (e.g. 2 for 2%)
     * @returns {{ applyAmount:number, branch:string, remainingInvoiceBalance:number, whtAmount:number }}
     */
    function computeIndiaWhtApplyForMatch(match, whtRate) {
        const roundingThreshold = 1.00
        const subtotal = Number(match?.subtotal || 0)
        const total    = Number(match?.total || 0)
        const apply    = Number(match?.apply || 0)
        const rateFr   = (Number(whtRate) || 0) / 100

        // 1. Calculate exact WHT: Calculated_WHT = Net_Invoice_Amount * WHT%
        const whtAmount = subtotal * rateFr

        // 2. Identify open balance: Remaining_Invoice_Balance = Total_Invoice_Amount - Received_Bank_Payment_Amount
        const remainingInvoiceBalance = total - apply

        // 3. Calculate difference: Diff = Absolute_Value(Remaining_Invoice_Balance - Calculated_WHT)
        const difference = Math.abs(remainingInvoiceBalance - whtAmount)

        if (difference <= roundingThreshold) {
            return {
                applyAmount: remainingInvoiceBalance,
                branch: 'fullClose',
                remainingInvoiceBalance,
                whtAmount
            }
        }

        const denom = total - whtAmount
        const applyAmount = denom !== 0 ? (apply * (whtAmount / denom)) : 0
        return {
            applyAmount,
            branch: 'partial',
            remainingInvoiceBalance,
            whtAmount
        }
    }

    /**
     * Creates the additional India WHT customer payment(s) for an applied
     * Cash App Transaction.
     *
     * Behaviour:
     *  - Applies the existing per-invoice rounding rule engine (full-close vs
     *    partial branch) to each invoice with apply > 0.
     *  - Splits the resulting WHT matches by Indian fiscal-year boundary
     *    (01.04.YYYY – 31.03.YYYY+1, keyed to today's system date):
     *      • invoice.trandate ≥ current FY start  → posts to whtAccount
     *      • invoice.trandate <  current FY start  → posts to lastYearWhtAccount
     *  - When the previous-FY account is not configured on the setup, all
     *    matches fall back to whtAccount (preserves legacy single-payment
     *    behaviour).
     *  - Creates one customer payment per non-empty bucket; if both buckets
     *    have invoices the result is two separate WHT payments.
     *
     * @param {Object}  args
     * @param {string|number} args.batchId
     * @param {string|number} args.cashAppTranId
     * @param {Object}  args.fields              The fields object passed to afterCreatePayment
     * @param {Object}  args.matches             All applied matches (apply > 0 filter applied internally)
     * @param {number}  args.whtRate
     * @param {string|number} args.whtAccount    custrecord_tb_wht_account (current FY)
     * @param {string|number} [args.lastYearWhtAccount] custrecord_tb_last_year_wht_account (previous FY)
     * @param {string|number} args.cashAppTransactionId Same as cashAppTranId, used by memo resolver
     * @param {Object}  [args.pluginData]
     * @param {Date}    [args.referenceDate=new Date()] Override for testing
     * @returns {Array<{ pymtId:(string|number), account:(string|number), bucket:string, matchCount:number, total:number }>}
     */
    function processIndiaWHTPayments(args) {
        const fn = `${scriptName}.processIndiaWHTPayments`
        const { batchId, cashAppTranId, fields, matches, whtRate,
            whtAccount, lastYearWhtAccount, pluginData = {}, referenceDate } = args

        const inWhtMatchesAll = Object.values(matches || {}).filter(m => Number(m?.apply) > 0)
        if (inWhtMatchesAll.length === 0) {
            log.audit(fn, 'India WHT skipped: no matches with apply>0.')
            return []
        }
        if (!whtRate || isNaN(parseFloat(whtRate))) {
            log.audit(fn, `India WHT skipped: invalid whtRate '${whtRate}'.`)
            return []
        }

        const fyStart = getCurrentIndianFYStart(referenceDate)
        const fyStartTime = fyStart.getTime()
        const hasLastYearAccount = !!lastYearWhtAccount

        // Bucket each match by its trandate vs the current Indian FY start.
        // When the previous-FY account isn't configured we fall back to the
        // current-FY account for everything (legacy behaviour).
        const buckets = {
            current:  { account: whtAccount,          matches: {}, total: 0 },
            previous: { account: lastYearWhtAccount,  matches: {}, total: 0 }
        }

        for (const m of inWhtMatchesAll) {
            const { applyAmount, branch, remainingInvoiceBalance, whtAmount } =
                computeIndiaWhtApplyForMatch(m, whtRate)

            if (!(applyAmount > 0)) {
                log.debug(fn, JSON.stringify({
                    skip: 'applyAmount<=0', invoice: m.id, branch, remainingInvoiceBalance, whtAmount, applyAmount
                }))
                continue
            }

            let bucketKey = 'current'
            if (hasLastYearAccount) {
                const trandate = parseTrandate(m.trandate)
                if (trandate && trandate.getTime() < fyStartTime) {
                    bucketKey = 'previous'
                } else if (!trandate) {
                    log.audit(fn, `India WHT: unable to parse trandate '${m.trandate}' for invoice ${m.id} — defaulting to current FY bucket.`)
                }
            }

            const bucket = buckets[bucketKey]
            bucket.matches[m.id] = { ...m, apply: applyAmount }
            bucket.total += applyAmount

            log.debug(fn, JSON.stringify({
                invoice: m.id, trandate: m.trandate, bucket: bucketKey,
                branch, remainingInvoiceBalance, whtAmount, applyAmount
            }))
        }

        const memoTemplates = getSetupMemoTemplates(pluginData?.configId)
        const created = []

        for (const key of ['current', 'previous']) {
            const bucket = buckets[key]
            const matchCount = Object.keys(bucket.matches).length
            if (matchCount === 0) continue

            if (!bucket.account) {
                log.error(fn, `India WHT: skipping ${key}-FY bucket — no account configured. matches=${matchCount}, total=${bucket.total}`)
                continue
            }

            const whtMemo = memoTemplates.whtMemo
                ? resolveMemoTemplate(memoTemplates.whtMemo, cashAppTranId, bucket.matches)
                : fields.memo

            try {
                const pymtId = createIndiaWHTPayment(
                    batchId, cashAppTranId,
                    { ...fields, cashAccount: bucket.account, amount: bucket.total, memo: whtMemo },
                    bucket.matches,
                    pluginData
                )
                log.audit(fn, `India WHT customer payment ${pymtId} created (${key} FY, account=${bucket.account}, matches=${matchCount}, total=${bucket.total.toFixed(2)})`)
                created.push({ pymtId, account: bucket.account, bucket: key, matchCount, total: bucket.total })
            } catch (err) {
                log.error(fn, `India WHT ${key}-FY payment failed: ${err.message}. ${err.stack || ''}`)
            }
        }

        if (created.length === 0) {
            log.error(fn, `India WHT: no payments created. inWhtMatchesAll=${JSON.stringify(inWhtMatchesAll.map(m => ({id:m.id, apply:m.apply, subtotal:m.subtotal, total:m.total, trandate:m.trandate})))}`)
        }

        return created
    }

    function populateWHTRegime(transactionId) {
        // Load the CashApp Transaction record, Get the WHT Regime from Cash App Config
        const rec = record.load({type:'customrecord_pri_cashapp_transaction', id:transactionId})
        const batch = rec.getValue({fieldId:'custrecord_pri_cashapp_trans_batch'})
        const lookup = search.lookupFields({
            type:'customrecord_pri_cashapp_batch',
            id:batch,
            columns:['custrecord_pri_cashapp_batch_setup.custrecord_tb_wht_regime']
        })

        // If the WHT Regime is set, get the WHT Rate from the WHT Regime record
        if (!!lookup?.['custrecord_pri_cashapp_batch_setup.custrecord_tb_wht_regime']?.[0]?.value) {
            const whtRegime = lookup['custrecord_pri_cashapp_batch_setup.custrecord_tb_wht_regime']?.[0]?.value
            const whtRate = search.lookupFields({
                type:'customrecord_pri_cashapp_wht_regime',
                id:whtRegime,
                columns:['custrecord_pri_cashapp_wht_rate']
            })?.['custrecord_pri_cashapp_wht_rate']
            // If the WHT Rate is set, set the WHT Rate on the CashApp Transaction record
            if (!!whtRate && !isNaN(parseFloat(whtRate))) {
                rec.setValue({fieldId:'custrecord_tb_wht_rate', value:parseFloat(whtRate)})
                rec.save()
                log.debug(`${fn}: WHT Rate Set for CashApp Transaction ${transactionId}`, {whtRate})
            }
        }
    }

    //#endregion WHT Payments

    function formatDate(options) {
        const fn = `${scriptName}.formatDate`
        const date = new Date('1/1/1900')
        if (typeof options === 'string') {
            const settings = config.load({type:config.Type.COMPANY_PREFERENCES})
            const userSettings = config.load({type:config.Type.USER_PREFERENCES})
            const companyDatePreference = settings.getValue({fieldId:'DATEFORMAT'})
            const userDatePreference = userSettings.getValue({fieldId:'DATEFORMAT'})
            try {
                const dt = formatDate({[userDatePreference]:options})
                if (options.includes(String(dt?.getFullYear()))) {
                    return dt
                } else {
                    const dt = formatDate({[companyDatePreference]:options})
                    if (options.includes(String(dt?.getFullYear()))) {
                        return dt
                    } else {
                        throw new Error(`${fn}: Invalid date format: ${options}`)
                    }
                }
            } catch(err) {
                throw new Error(`${fn}: Invalid date format: ${options}. ${err.message}`)
            }
        }
        if (options.yymmdd) {
            date.setFullYear(`20${options.yymmdd.substring(0,2)}`)
            date.setMonth(parseInt(options.yymmdd.substring(2,4))-1)
            date.setDate(options.yymmdd.substring(4))
        } else if (options.yyyymmdd) {
            date.setFullYear(options.yyyymmdd.substring(0,4))
            date.setMonth(parseInt(options.yyyymmdd.substring(4,6))-1)
            date.setDate(options.yyyymmdd.substring(6))
        } else if (options.mmddyyyy) {
            date.setFullYear(options.mmddyyyy.split('/')[2])
            date.setMonth(parseInt(options.mmddyyyy.split('/')[0])-1)
            date.setDate(options.mmddyyyy.split('/')[1])
        } else if (options.mmddyy) {
            date.setFullYear(`20${options.mmddyy.substring(4)}`)
            date.setMonth(parseInt(options.mmddyy.substring(2,4))-1)
            date.setDate(options.mmddyy.substring(0,2))
        } else if (options["D/M/YYYY"] || options["DD/MM/YYYY"]) {
            const opt = options["D/M/YYYY"] || options["DD/MM/YYYY"]
            date.setFullYear(opt.split('/')[2])
            date.setDate(opt.split('/')[0])
            date.setMonth(parseInt(opt.split('/')[1])-1)
        } else if (options["M/D/YYYY"] || options["MM/DD/YYYY"]) {
            const opt = options["M/D/YYYY"] || options["MM/DD/YYYY"]
            date.setFullYear(opt.split('/')[2])
            date.setDate(opt.split('/')[1])
            date.setMonth(parseInt(opt.split('/')[0])-1)
        } else if (options["YYYY/MM/DD"] || options["YYYY-MM-DD"] || options["YYYY/M/D"] || options["YYYY-M-D"]) {
            const opt = options["YYYY/MM/DD"] || options["YYYY-MM-DD"] || options["YYYY/M/D"] || options["YYYY-M-D"]
            const delim = opt.includes('/') ? '/' : '-'
            date.setFullYear(opt.split(delim)[0])
            date.setDate(opt.split(delim)[2])
            date.setMonth(parseInt(opt.split(delim)[1])-1)
        } else if (options["D.M.YYYY"] || options["DD.MM.YYYY"]) {
            const opt = options["D.M.YYYY"] || options["DD.MM.YYYY"]
            date.setFullYear(opt.split('.')[2])
            date.setDate(opt.split('.')[0])
            date.setMonth(parseInt(opt.split('.')[1])-1)
        } else if (options["D-MONTH-YYYY"] || options["DD-MONTH-YYYY"]) {
            const opt = options["D-MONTH-YYYY"] || options["DD-MONTH-YYYY"]
            date.setFullYear(opt.split('-')[2])
            date.setDate(opt.split('-')[0])
            const months = ['january','february','march','april','may','june','july','august','september','october','november','december']
            const month = months.indexOf(opt.split('-')[1].toLowerCase())
            if (month > -1)
                date.setMonth(month)
        } else if (options["D MONTH, YYYY"] || options["DD MONTH, YYYY"]) {
            const opt = options["D MONTH, YYYY"] || options["DD MONTH, YYYY"]
            date.setFullYear(opt.split(', ')[1])
            date.setDate(opt.split(' ')[0])
            const months = ['january','february','march','april','may','june','july','august','september','october','november','december']
            const month = months.indexOf(opt.split(' ')[1].split(',')[0].toLowerCase())
            if (month > -1)
                date.setMonth(month)
        } else if (options["D-Mon-YYYY"] || options["DD-Mon-YYYY"]) {
            const opt = options["D-Mon-YYYY"] || options["DD-Mon-YYYY"]
            date.setFullYear(opt.split('-')[2])
            date.setDate(opt.split('-')[0])
            const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
            const month = months.indexOf(opt.split('-')[1].toLowerCase())
            if (month > -1)
                date.setMonth(month)
        }
        if (date.getFullYear() > 1900) {
            date.setHours(0)
            date.setMinutes(0)
            date.setSeconds(0)
            date.setMilliseconds(0)
        }
        log.debug(fn, {options, date})
        if (date.getFullYear() > 1900) {
            return date
        }
        return null
    }
    
    //#endregion Script Endpoints
    /* ====================================================================================================== */
    //#region Dynamic Memo Templates

    const MEMO_MAX_LEN = 299
    function truncateMemo(val) { return val && val.length > MEMO_MAX_LEN ? val.substring(0, MEMO_MAX_LEN) : val }

    const INVOICE_FIELD_ALIASES = {
        period: 'postingperiod',
        name: 'entityname',
        amount: 'foreigntotal'
    }

    /**
     * Resolves a memo template string by replacing placeholders with actual values.
     *
     * Template syntax:
     *   ${fieldId}              - Value of fieldId from the CashApp Transaction record
     *                             e.g. ${custrecord_pri_cashapp_trans_cust_id}
     *   $[invoices.fieldId]     - Comma-separated values of fieldId from all applied invoices
     *                             e.g. $[invoices.tranid], $[invoices.period]
     *
     * @param {string} template - The template string with placeholders
     * @param {string|number} cashAppTransactionId - CashApp Transaction record id
     * @param {Object} matches - The matches object (keyed by transaction id)
     * @returns {string} The resolved memo string
     */
    function resolveMemoTemplate(template, cashAppTransactionId, matches) {
        if (!template) return ''
        const fn = `${scriptName}.resolveMemoTemplate`
        let result = template
        log.debug(fn, { template, cashAppTransactionId, matchCount: matches ? Object.keys(matches).length : 0 })

        // 1. Resolve ${fieldId} placeholders from the CashApp Transaction record
        const transPattern = /\$\{([^}]+)\}/g
        const transTokens = [...template.matchAll(transPattern)]
        if (transTokens.length > 0 && cashAppTransactionId) {
            const columns = [...new Set(transTokens.map(t => t[1]))]
            log.debug(`${fn}: Transaction field tokens`, { columns })
            try {
                const values = search.lookupFields({
                    type: 'customrecord_pri_cashapp_transaction',
                    id: cashAppTransactionId,
                    columns
                })
                log.debug(`${fn}: Transaction field values`, JSON.stringify(values))
                for (const token of transTokens) {
                    const fieldId = token[1]
                    let val = values?.[fieldId] ?? ''
                    if (Array.isArray(val))
                        val = val.map(v => v.text || v.value || v).join(', ')
                    result = result.replace(token[0], () => String(val))
                }
            } catch (err) {
                log.error(fn, `Transaction field lookup failed: ${err.message}`)
                for (const token of transTokens)
                    result = result.replace(token[0], '')
            }
        }

        // 2. Resolve $[invoices.fieldId] placeholders from applied invoices
        const invPattern = /\$\[invoices\.([^\]]+)\]/g
        const invTokens = [...template.matchAll(invPattern)]
        if (invTokens.length > 0) {
            const applied = matches
                ? Object.values(matches).filter(m => m.apply > 0)
                : []
            log.debug(`${fn}: Invoice tokens`, { requestedFields: invTokens.map(t => t[1]), appliedCount: applied.length })

            if (applied.length === 0) {
                log.debug(`${fn}: No applied matches, clearing invoice placeholders`)
                for (const token of invTokens)
                    result = result.replace(token[0], '')
            } else {
                const matchKeys = new Set(Object.keys(applied[0] || {}))
                const requestedFields = [...new Set(invTokens.map(t => t[1]))]
                const fieldsToQuery = requestedFields.filter(f => {
                    const aliased = INVOICE_FIELD_ALIASES[f] || f
                    return !matchKeys.has(f) && !matchKeys.has(aliased)
                })

                let extraData = {}
                if (fieldsToQuery.length > 0) {
                    const ids = applied.map(m => m.id).filter(Boolean)
                    log.debug(`${fn}: Querying extra invoice fields`, { fieldsToQuery, invoiceIds: ids })
                    if (ids.length > 0) {
                        try {
                            const cols = fieldsToQuery.map(f => {
                                const col = INVOICE_FIELD_ALIASES[f] || f
                                return `BUILTIN.DF(t.${col}) as "${f}"`
                            }).join(', ')
                            const q = `SELECT t.id, ${cols} FROM transaction t WHERE t.id IN (${ids.join(',')})`
                            const rows = suiteQL.runSuiteQL({ query: q }).asMappedResults()
                            for (const r of rows) extraData[String(r.id)] = r
                            log.debug(`${fn}: Extra invoice data`, JSON.stringify(extraData))
                        } catch (err) {
                            log.error(fn, `Invoice field query failed [${fieldsToQuery}]: ${err.message}`)
                        }
                    }
                }

                for (const token of invTokens) {
                    const fieldId = token[1]
                    const aliased = INVOICE_FIELD_ALIASES[fieldId] || fieldId
                    const vals = applied.map(m => {
                        if (m[fieldId] != null && m[fieldId] !== '') return m[fieldId]
                        if (m[aliased] != null && m[aliased] !== '') return m[aliased]
                        const ex = extraData[String(m.id)]
                        if (ex?.[fieldId] != null && ex[fieldId] !== '') return ex[fieldId]
                        return null
                    }).filter(v => v != null)
                    const unique = [...new Set(vals.map(String))]
                    log.debug(`${fn}: Resolved $[invoices.${fieldId}]`, { values: unique })
                    result = result.replace(token[0], () => unique.join(', '))
                }
            }
        }

        log.debug(`${fn}: Final resolved memo`, { template, result: result.trim() })
        return result.trim()
    }

    /**
     * Looks up the dynamic memo templates configured on the CashApp Setup record.
     *
     * @param {string|number} setupId - The customrecord_pri_cashapp_setup record id
     * @returns {{ memo:string, whtMemo:string, customMemo:string }}
     */
    function getSetupMemoTemplates(setupId) {
        const fn = `${scriptName}.getSetupMemoTemplates`
        if (!setupId) {
            log.debug(fn, `[MEMO TRACE] setupId is ${setupId} — cannot look up memo templates. Returning empty.`)
            return {}
        }
        log.debug(fn, `[MEMO TRACE] Looking up memo templates from customrecord_pri_cashapp_setup id=${setupId}`)
        try {
            const lookup = search.lookupFields({
                type: 'customrecord_pri_cashapp_setup',
                id: setupId,
                columns: [
                    'custrecord_tb_cashapp_memo',
                    'custrecord_tb_cashapp_wht_memo',
                    'custrecord_tb_cashapp_custom_memo',
                    'custrecord_tb_cashapp_prepay_memo'
                ]
            })
            log.debug(fn, `[MEMO TRACE] Raw lookup result: custrecord_tb_cashapp_memo="${lookup?.custrecord_tb_cashapp_memo}", custrecord_tb_cashapp_wht_memo="${lookup?.custrecord_tb_cashapp_wht_memo}", custrecord_tb_cashapp_custom_memo="${lookup?.custrecord_tb_cashapp_custom_memo}", custrecord_tb_cashapp_prepay_memo="${lookup?.custrecord_tb_cashapp_prepay_memo}"`)
            const templates = {
                memo: lookup?.custrecord_tb_cashapp_memo || '',
                whtMemo: lookup?.custrecord_tb_cashapp_wht_memo || '',
                customMemo: lookup?.custrecord_tb_cashapp_custom_memo || '',
                prepayMemo: lookup?.custrecord_tb_cashapp_prepay_memo || ''
            }
            return templates
        } catch (err) {
            log.error(fn, `[MEMO TRACE] Failed to look up memo templates for setupId=${setupId}: ${err.message}`)
            return {}
        }
    }

    /**
     * Resolves memo templates from the CashApp Setup and applies them to a payment record.
     * Returns the resolved values for downstream use (WHT payments, customer deposits, etc.).
     *
     * Setup fields read:
     *   custrecord_tb_cashapp_memo        → payment native 'memo' field
     *   custrecord_tb_cashapp_wht_memo    → returned for India WHT payment memo
     *   custrecord_tb_cashapp_custom_memo → payment custom field 'custbody_tb_custom_memo',
     *                                       and memo for customer deposits / unapplied payments
     *
     * @param {Object|null} paymentRec - The payment record (null to resolve without setting)
     * @param {string|number} cashAppTransactionId
     * @param {Object} matches
     * @param {Object} pluginData
     * @returns {{ memo:string, whtMemo:string, customMemo:string }}
     */
    function setPaymentMemos(paymentRec, cashAppTransactionId, matches, pluginData) {
        const fn = `${scriptName}.setPaymentMemos`
        const configId = pluginData?.configId
        log.debug(fn, `[MEMO TRACE] Entry: cashAppTranId=${cashAppTransactionId}, configId=${configId}, hasPaymentRec=${!!paymentRec}, matchCount=${Object.keys(matches || {}).length}`)

        const templates = getSetupMemoTemplates(configId)
        log.debug(fn, `[MEMO TRACE] Setup memo templates from configId=${configId}: memo="${templates.memo || ''}", whtMemo="${templates.whtMemo || ''}", customMemo="${templates.customMemo || ''}"`)

        const resolved = {}

        if (templates.memo) {
            resolved.memo = truncateMemo(resolveMemoTemplate(templates.memo, cashAppTransactionId, matches))
            log.debug(fn, `[MEMO TRACE] Resolved memo template: "${templates.memo}" → "${resolved.memo}"`)
            if (resolved.memo && paymentRec) {
                paymentRec.setValue({ fieldId: 'memo', value: resolved.memo })
                log.debug(fn, `[MEMO TRACE] SET paymentRec.memo = "${resolved.memo}"`)
            }
        } else {
            log.debug(fn, `[MEMO TRACE] No memo template configured on setup — payment memo NOT changed`)
        }

        if (templates.whtMemo) {
            resolved.whtMemo = truncateMemo(resolveMemoTemplate(templates.whtMemo, cashAppTransactionId, matches))
            log.debug(fn, `[MEMO TRACE] Resolved whtMemo template: "${templates.whtMemo}" → "${resolved.whtMemo}"`)
        }

        if (templates.customMemo) {
            resolved.customMemo = truncateMemo(resolveMemoTemplate(templates.customMemo, cashAppTransactionId, matches))
            log.debug(fn, `[MEMO TRACE] Resolved customMemo template: "${templates.customMemo}" → "${resolved.customMemo}"`)
            if (resolved.customMemo && paymentRec) {
                paymentRec.setValue({ fieldId: 'custbody_tb_custom_memo', value: resolved.customMemo })
                log.debug(fn, `[MEMO TRACE] SET paymentRec.custbody_tb_custom_memo = "${resolved.customMemo}"`)
            }
        }

        if (templates.prepayMemo) {
            resolved.prepayMemo = truncateMemo(resolveMemoTemplate(templates.prepayMemo, cashAppTransactionId, matches))
            log.debug(fn, `[MEMO TRACE] Resolved prepayMemo template: "${templates.prepayMemo}" → "${resolved.prepayMemo}"`)
        }

        log.debug(fn, `[MEMO TRACE] Final resolved memos: ${JSON.stringify(resolved)}`)
        return resolved
    }

    //#endregion Dynamic Memo Templates
    /* ====================================================================================================== */
    //#region Private methods

    //#endregion Private methods
    /* ====================================================================================================== */

    return { 
        getCashAppTransactions,
        newCashAppTransaction,
        autoApplyCashAppTransaction,
        createCashAppMatchingRules,
        changeCashAppCustomer,

        filterDuplicateTransactions,
        formatDate,
        addCashAppMatch,
        getAddendaDetails,
        queryInvoicesById,
        queryInvoicesByRefNo,
        queryOpenInvoicesByEntity,
        queryInvoicesByAmount,
        queryOpenTransactionsByClientName,
        createWriteOffJE,
        createCustomerDeposit,
        shouldAutoCreatePrepayDeposit,
        createCurrencyNettingPayment,
        createIndiaWHTPayment,
        processIndiaWHTPayments,
        populateWHTRegime,
        resolveMemoTemplate,
        getSetupMemoTemplates,
        setPaymentMemos
    }
})
