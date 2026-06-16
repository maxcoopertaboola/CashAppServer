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
// 2026-03-11   Jeff Dennis   PTM28554: Netting Account support
// 2026-03-17   Jeff Dennis   PTM28554: Added WHT Support.
//
//-----------------------------------------------------------------------------------------------------------

/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 * @NScriptType plugintypeimpl
 */
define([
    'N/log',
    'N/config',
    'N/search',
    'N/record',
    'N/https',
    '/.bundle/521028/PRI_CashApp_Common',
    './TB_CashApp_Common'
], 
/**
 * Plugin interface for Prolecto Cash Application
 *
 * @exports PRI_CashApp_PLT
 */
function(log, config, search, record, https, cashAppCommon, tblaCashAppCommon) {
    const scriptName = 'TB_CashApp_Citibank'

    function safeParseTblaWht(raw) {
        if (!raw) return null
        if (typeof raw === 'object') return raw
        try { return JSON.parse(raw) } catch (_) { return null }
    }

    /* ====================================================================================================== */

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
        return tblaCashAppCommon.getCashAppTransactions(batchId, batchData, transactions, pluginData)
    }

    /* ====================================================================================================== */

    /**
     * Called by PRI_CashApp_Common.createCashAppTransaction immediately after a new PRI CashApp Transaction record is saved.
     * 
     * @param {string|number} cashAppTransactionId - The PRI CashApp Transaction id
     * @param {Object} transactionData - The transactional JSON data from the parsed batch file
     * @param {Object} batchData - The JSON data from the parsed batch file
     * @param {Object} pluginData - Any data that is entered into in the PRI CashApp Configuration Plug-in Data field is passed here.
     */
    function newCashAppTransaction(transactionId, transactionData, batchData, pluginData) {
        // Call the base method
        tblaCashAppCommon.newCashAppTransaction(transactionId, transactionData, batchData, pluginData)

        // Populate the WHT Regime on the CashApp Transaction record
        tblaCashAppCommon.populateWHTRegime(transactionId)
    }
    
    /* ====================================================================================================== */

    /**
     * Called by PRI_CashApp_Common.matchCashAppTransaction
     * 
     * Used to create and mutate matching results for the Cash Application Transaction.
     * 
     * @param {Object} matches - An object containing key/value pairs of matched transactions, where the key is the transaction id.
     * @param {Object} transactionData - The transactional JSON data from the parsed batch file
     * @param {Object} pluginData - Any data that is entered into in the PRI CashApp Configuration Plug-in Data field is passed here.
     * @returns {Object?} Returns an optional object of matched transaction key/value pairs. If no data is returned the calling method will default to using the matches object passed to this method.
     */
    function matchCashAppTransaction(matches, transactionData, pluginData) {
        const fn = `${scriptName}.matchCashAppTransaction`
            addendaLines = tblaCashAppCommon.getAddendaDetails(transactionData, pluginData)
        log.debug(fn, {addendaLines})

        // Invoice Reference - Match to the Invoice Reference Number (from addenda)
        const invoiceRefs = []
        for (const line of addendaLines) {
            if (!!line.ref && !invoiceRefs.includes(line.ref)) invoiceRefs.push(line.ref)
        }
        log.debug(`${fn}: Addenda Details`, {invoiceRefs: invoiceRefs.length})

        const invoiceMatches = {}
        const entities = []
        let matchTotal = 0

        // Amount-based matching: if the payment amount uniquely identifies one open invoice
        // in this subsidiary (by unpaid balance), treat it as an exact auto-match candidate.
        if (!!transactionData?.paymentAmount) {
            const amountMatches = tblaCashAppCommon.queryInvoicesByAmount(transactionData.paymentAmount, transactionData.subsidiary)
            log.debug(`${fn}: Amount Matches`, {count: amountMatches.length, paymentAmount: transactionData.paymentAmount})
            if (amountMatches.length === 1) {
                const inv = amountMatches[0]
                if (!entities.find(e => e.id === inv.entity)) entities.push({id: inv.entity, name: inv.entityname})
                inv.apply = (parseFloat(transactionData.paymentAmount)*100)/100
                matchTotal += inv.apply
                tblaCashAppCommon.addCashAppMatch(matches, inv.id, inv, 'Taboola Amount Match', 1)
            }
        }

        // Compile an object of Invoice matches based on the Invoice Reference
        if (invoiceRefs.length) {
            for (const inv of tblaCashAppCommon.queryInvoicesByRefNo(invoiceRefs, transactionData.subsidiary)) {
                if (!entities.find(e => e.id === inv.entity)) entities.push({id: inv.entity, name: inv.entityname})
                const addenda = addendaLines.filter(l => {
                    if (!l.ref || !inv.otherrefnum) return false
                    return inv.otherrefnum.toString() == l.ref.toString()
                })
                if (!addenda || !addenda.length) continue
                for (const line of addenda) {
                    if (!invoiceMatches.hasOwnProperty(inv.id)) {
                        invoiceMatches[inv.id] = inv
                        invoiceMatches[inv.id].apply = (parseFloat(line.amount)*100)/100
                        matchTotal += invoiceMatches[inv.id].apply
                    } else {
                        invoiceMatches[inv.id].apply += (parseFloat(line.amount)*100)/100
                        matchTotal += invoiceMatches[inv.id].apply
                    }
                }
            }
        }
        
        // Add all Invoice Reference matches to the matches object
        let invoiceMatchCount = 0
        for (const id in invoiceMatches) {
            tblaCashAppCommon.addCashAppMatch(matches, id, invoiceMatches[id], 'Taboola Addenda Matching', 2)
            ++invoiceMatchCount
        }

        // Add matches based on the customer when a single entity has been identified
        if (entities.length === 1) {
            const openInvoices = tblaCashAppCommon.queryOpenInvoicesByEntity(entities[0].id, transactionData.subsidiary)
            if (openInvoices.length) {
                openInvoices.forEach(inv => 
                    tblaCashAppCommon.addCashAppMatch(matches, inv.id, inv, `Taboola Customer Match: '${entities[0].name}'`, 3))
            }
        }

        // If no matches at this point, try a modified fuzzy match based on the customer name
        const canShowFuzzyMatch = !Object.keys(matches).length 
        || (!!transactionData?.paymentAmount && parseFloat(matchTotal.toFixed(2)) < parseFloat(transactionData.paymentAmount.toFixed(2)))
        if (canShowFuzzyMatch && !!transactionData?.customerName) {
            let names = [transactionData.customerName]
            const nameSplit = transactionData.customerName.split(' ')
            if (nameSplit.length > 2) {
                names.push(nameSplit.slice(0,2).join(' '))
            }

            const fuzzyMatch = tblaCashAppCommon.queryOpenTransactionsByClientName(names, transactionData.subsidiary)
            if (fuzzyMatch.length)
                fuzzyMatch.forEach(m => tblaCashAppCommon.addCashAppMatch(matches, m.id, m, `Taboola Fuzzy Match: '${transactionData.customerName}'`, 999))
        }
        
        log.debug(fn, {matches:Object.keys(matches).length})
        return matches
    }
    
    /* ====================================================================================================== */

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
        return tblaCashAppCommon.autoApplyCashAppTransaction(cashAppTransactionId, paymentAmount, sortedTransactions, pluginData)
    }
    
    /* ====================================================================================================== */

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
        return tblaCashAppCommon.createCashAppMatchingRules(batchId, cashAppTransactionId, customerId, pluginData)
    }
    
    /* ====================================================================================================== */

    /**
     * Called by PRI_CashApp_Common.sortMatchedTransactions
     * 
     * Used to sort the matched transactions.
     * 
     * @param {Array<Object>} orderedTransactions - The ordered transactions.
     * @param {Object} pluginData - Any data that is entered into in the PRI CashApp Configuration Plug-in Data field is passed here.
     * @returns {Array<Object>} Returns the sorted transactions.
     */
    function sortMatchedTransactions(orderedTransactions, pluginData) {
        const fn = `${scriptName}.sortMatchedTransactions`
        return orderedTransactions
    }
    
    /* ====================================================================================================== */

    /**
     * Called by PRI_CashApp_Common.writeOff
     * 
     * Used to create a writeoff transaction.
     * 
     * @param {string|number} batchId - The id of the batch that the writeoff is being created for.
     * @param {string|number} cashAppTranId - The id of the cashapp transaction, used to fetch data
     * @param {string} type - The type of writeoff ('overpayment' or, 'bankfeeunderpayment', or 'underpayment').
     * @param {Object} fields - The fields that are being used to create the writeoff.
     * @param {Object} pluginData - Any data that is entered into in the PRI CashApp Configuration Plug-in Data field is passed here.
     * @returns {Object?} Returns the writeoff transaction record. If no data is returned the calling method will default to using the default writeoff process.
     */
    function createWriteOffTransaction(batchId, cashAppTranId, type, fields, pluginData = {}) {
        const fn = `${scriptName}.createWriteOffTransaction`
        // log.debug(fn, {batchId, cashAppTranId, type, fields, pluginData})
        
        return tblaCashAppCommon.createWriteOffJE(batchId, cashAppTranId, 
            fields.date, fields.subsidiary, fields.customer, fields.amount, fields.debitAcct, fields.creditAcct, '', 
            fields.location, type, fields.currency, fields.invoice)
    }
    
    /* ====================================================================================================== */

    /**
     * Called by PRI_CashApp_Common.createPayment. 
     * 
     * Used to overwrite/mutate the payment record before it is saved.
     * 
     * @param {Object} paymentRec - The payment record that is being created.
     * @param {string|number} batchId - The id of the batch that the payment is being created for.
     * @param {string|number} cashAppTransactionId - The id of the cashapp transaction, used to fetch data
     * @param {Object} fields - The fields that are being used to create the payment.
     * @param {boolean} fields.isDummyPayment - Whether the payment is a dummy payment.
     * @param {Object} matches - The matches that are being used to create the payment.
     * @param {Object} credits - The credits that are being used to create the payment.
     * @param {Object} pluginData - Any data that is entered into in the PRI CashApp Configuration Plug-in Data field is passed here.
     * @param {boolean} didRetry - Whether the payment was created as a result of a retry attempt.
     * @returns {boolean?} Returns false to prevent the payment from being created.
     */
    function beforeCreatePayment(paymentRec, batchId, cashAppTransactionId, fields, matches, credits, pluginData = {}, didRetry = false) {
        const fn = `${scriptName}.beforeCreatePayment`,
            { date, subsidiary, customer, location, amount = 0, paymentMethod, memo, checkNumber = '', invoice = '' } = fields
        //! NOTE: Make any mutations to paymentRec before it is saved.
        // If you return false, the payment will not be created.

        const setup = pluginData?.setup
        log.debug(fn, {setup})
        log.debug(fn, {matches})

        // Taboola WHT (for Thailand)
        const whtRate = fields?.taboolaWHTData?.rate
        // const whtAmount = fields?.taboolaWHTData?.amount
        if (!!setup?.taboolaWHTRegime) {
            // Thailand WHT
            const thWhtMatches = Object.values(matches).filter(m => m.apply > 0 && m.billcountry === 'TH')
            log.debug(fn, {thWhtMatches})
            const thWhtIds = thWhtMatches.map(m => m.tranid)
            const thWhtInvoices = tblaCashAppCommon.queryInvoicesById(thWhtIds, subsidiary, false)

            let whtAmount = 0, totalInvTax = 0, totalPayment = 0
            if (thWhtMatches.length > 0) {
                totalInvTax = thWhtInvoices.reduce((acc, inv) => acc + (inv.taxamount || 0), 0)

                const invByTranid = {}
                thWhtInvoices.forEach(inv => { invByTranid[inv.tranid] = inv })

                whtAmount = thWhtMatches.reduce((acc, m) => {
                    const parsed = safeParseTblaWht(m.tblaWht)
                    if (parsed?.whtMarkup != null) return acc + parsed.whtMarkup
                    if (!whtRate) return acc
                    const subtotal = m.subtotal ?? invByTranid[m.tranid]?.totalnetoftax ?? 0
                    return acc + (subtotal * (whtRate / 100))
                }, 0)
                totalPayment = thWhtMatches.reduce((acc, m) => {
                    const parsed = safeParseTblaWht(m.tblaWht)
                    let markup = parsed?.whtMarkup
                    if (markup == null) {
                        const subtotal = m.subtotal ?? invByTranid[m.tranid]?.totalnetoftax ?? 0
                        markup = whtRate ? (subtotal * (whtRate / 100)) : 0
                    }
                    return acc + (m.apply - parseFloat(markup.toFixed(2)))
                }, 0)

                paymentRec.setValue({fieldId:'custbody_invoice_type', value:'2'})  // Intentionaly Hard-coded Payment Type for WHT
                paymentRec.setValue({fieldId:'custbody_tax_code_body', value:'1002'})  // Intentionaly Hard-coded Payment Type for WHT
                paymentRec.setValue({fieldId:'custbody_taxamt', value:totalInvTax})

                paymentRec.setValue({fieldId:'custbody_journal_type', value:'3'}) // Intentionaly Hard-coded Payment Type for WHT
                paymentRec.setValue({fieldId:'custbody_chk_submit_customgl', value:true}) // Intentionaly Hard-coded Custom GL for WHT
                paymentRec.setValue({fieldId:'custbody_total_payment', value:totalPayment})
                paymentRec.setValue({fieldId:'custbody_total_wh_tax', value:whtAmount})
                log.debug(fn, {whtRate, whtAmount, totalInvTax, totalPayment})
            }
        }

        // Taboola Cash App Transaction - Create a Payment using a Netting Account
        const [nettingPayment, nettingAccount] = tblaCashAppCommon.createCurrencyNettingPayment(
            batchId, cashAppTransactionId, fields, matches, pluginData)
        if (!!nettingPayment && !!nettingAccount) {
            paymentRec.setValue({fieldId:'undepfunds',value:'F'})
            paymentRec.setValue({fieldId:'account',value:nettingAccount})
            return true
        }

        // Dynamic memo setup from the CashApp Setup configuration
        log.debug(fn, `[MEMO TRACE] Before setPaymentMemos: configId = ${pluginData?.configId}, memo on rec = "${paymentRec.getValue({fieldId:'memo'})}"`)
        const resolvedMemos = tblaCashAppCommon.setPaymentMemos(paymentRec, cashAppTransactionId, matches, pluginData)
        log.debug(fn, `[MEMO TRACE] After setPaymentMemos: memo on rec = "${paymentRec.getValue({fieldId:'memo'})}", resolvedMemos = ${JSON.stringify(resolvedMemos)}`)

        // If customer's custentitytb_actual_pay_term = 27, create a deposit instead
        const customerPayTerm = search.lookupFields({
            type:'customer',
            id:fields.customer,
            columns:['custentitytb_actual_pay_term']
        })?.custentitytb_actual_pay_term ?? ''
        if (customerPayTerm.toString() === '27' || [27,'27'].includes(customerPayTerm?.[0]?.value)) {
            if (resolvedMemos.customMemo) {
                fields.memo = resolvedMemos.customMemo
                fields.customMemo = resolvedMemos.customMemo
            } else if (resolvedMemos.memo) {
                fields.memo = resolvedMemos.memo
            }
            return tblaCashAppCommon.createCustomerDeposit(batchId, cashAppTransactionId, fields, pluginData)
        }
        
        return true
    }
    
    /* ====================================================================================================== */

    /**
     * Called by PRI_CashApp_Common.createPayment. 
     * 
     * Used to overwrite/mutate the payment record before it is saved.
     * 
     * @param {string} pymtId - The payment id.
     * @param {string|number} batchId - The id of the batch that the payment is being created for.
     * @param {string|number} cashAppTranId - The id of the cashapp transaction, used to fetch data
     * @param {Object} fields - The fields that are being used to create the payment.
     * @param {boolean} fields.isDummyPayment - Whether the payment is a dummy payment.
     * @param {Object} matches - The matches that are being used to create the payment.
     * @param {Object} credits - The credits that are being used to create the payment.
     * @param {Object} pluginData - Any data that is entered into in the PRI CashApp Configuration Plug-in Data field is passed here.
     * @param {boolean} didRetry - Whether the payment was created as a result of a retry attempt.
     */
    function afterCreatePayment(pymtId, batchId, cashAppTranId, fields, matches, credits, pluginData = {}, didRetry = false) {
        const fn = `${scriptName}.afterCreatePayment: ${pymtId}`
        // log.debug(fn, '*** NOT IMPLEMENTED ***')

        const setup = pluginData?.setup

        const lookup = search.lookupFields({
            type:'customrecord_pri_cashapp_batch',
            id:batchId,
            columns:[
                'custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_subsidiary',
                'custrecord_pri_cashapp_batch_setup.custrecord_tb_wht_account',
                'custrecord_pri_cashapp_batch_setup.custrecord_tb_last_year_wht_account'
            ]
        })
        const subsidiary = lookup?.['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_subsidiary']?.[0]?.value
        const whtAccount = lookup?.['custrecord_pri_cashapp_batch_setup.custrecord_tb_wht_account']?.[0]?.value
        // India WHT only: optional override account for invoices dated before
        // 01.04 of the current Indian fiscal year.
        const lastYearWhtAccount = lookup?.['custrecord_pri_cashapp_batch_setup.custrecord_tb_last_year_wht_account']?.[0]?.value || null

        // Taboola WHT
        const whtRate = fields?.taboolaWHTData?.rate
        const certificateNumber = fields?.taboolaWHTData?.certificateNumber
        log.debug(fn, {subsidiary, whtAccount, lastYearWhtAccount, whtRate, certificateNumber, regime:setup?.taboolaWHTRegime})
        if (!fields.isDummyPayment && !!setup?.taboolaWHTRegime) {
            // Thailand WHT
            const thWhtMatches = Object.values(matches).filter(m => m.apply > 0 && m.billcountry === 'TH')
            if (thWhtMatches.length > 0 && String(setup.taboolaWHTRegime) === '1') {
                const whtAmount = thWhtMatches.reduce((acc, inv) => {
                    const parsed = safeParseTblaWht(inv.tblaWht)
                    if (parsed?.whtMarkup != null) return acc + parsed.whtMarkup
                    if (!whtRate) return acc
                    return acc + ((inv.subtotal ?? 0) * (whtRate / 100))
                }, 0)
                const totalPayment = thWhtMatches.reduce((acc, inv) => {
                    const parsed = safeParseTblaWht(inv.tblaWht)
                    let markup = parsed?.whtMarkup
                    if (markup == null) {
                        markup = whtRate ? ((inv.subtotal ?? 0) * (whtRate / 100)) : 0
                    }
                    return acc + (inv.apply - parseFloat(markup.toFixed(2)))
                }, 0)

                // Create customrecord_custom_gl_wh_custpayment record
                const rec = record.create({type:'customrecord_custom_gl_wh_custpayment'})
                rec.setValue({fieldId:'custrecord_cgl_cp_tran_ref', value:pymtId})
                rec.setValue({fieldId:'custrecord_cgl_cp_account', value:whtAccount})
                rec.setValue({fieldId:'custrecord_cgl_cp_tax_rate', value:whtRate})
                rec.setValue({fieldId:'custrecord_cgl_cp_foreign_base', value:totalPayment})
                rec.setValue({fieldId:'custrecord_cgl_cp_tax_base', value:totalPayment})
                rec.setValue({fieldId:'custrecord_cgl_cp_foreign_amount', value:whtAmount})
                rec.setValue({fieldId:'custrecord_cgl_cp_amount', value:whtAmount})
                rec.setValue({fieldId:'custrecord_cgl_cp_wh_date', value:tblaCashAppCommon.formatDate(fields.date)})
                rec.setValue({fieldId:'custrecord_cgl_cp_subsidiary', value:subsidiary})
                rec.setValue({fieldId:'custrecord_cgl_cp_wh_no', value:certificateNumber})
                const customGLId = rec.save()
                log.debug(fn, `Custom GL ${customGLId} created.`)

                // Blind-save payment
                // NOTE: Moved this logic to a Suitelet as this script cannot trigger GL Plugins (coming upstream from a UE)
                // const pymt = record.load({type:'customerpayment', id:pymtId})
                // pymt.setValue({fieldId:'customform', value:155}) // Intentionaly Hard-coded Custom Form for WHT
                // pymt.save()
                // log.debug(fn, `Payment ${pymtId} blind-saved.`)
                try {
                    const response = https.requestSuitelet({
                        scriptId:'customscript_tb_cashapp_sl',
                        deploymentId:'customdeploy_tb_cashapp_sl',
                        method:'GET',
                        urlParams:{
                            action:'blind-save-th-payment',
                            paymentId:pymtId
                        }
                    })
                    log.debug(`${fn}: Blind-save TH WHT payment response`, response)
                } catch (err) {
                    log.error(fn, `Failed to blind-save TH WHT payment. ${err.message}`)
                }
            }
            // India WHT
            // Delegates to the shared helper in TB_CashApp_Common which applies
            // the per-invoice rounding rule engine AND splits matches by Indian
            // fiscal-year boundary (01.04.YYYY – 31.03.YYYY+1, keyed to today's
            // system date) so invoices dated before the current FY post to
            // lastYearWhtAccount and the rest post to whtAccount. Two separate
            // customer payments are created when both buckets have matches.
            const inWhtMatches = Object.values(matches).filter(m => m.apply > 0 && m.billcountry === 'IN')
            log.debug(fn, {inWhtMatches})
            if (inWhtMatches.length > 0 && String(setup.taboolaWHTRegime) === '2') {
                try {
                    tblaCashAppCommon.processIndiaWHTPayments({
                        batchId,
                        cashAppTranId,
                        fields,
                        matches: inWhtMatches.reduce((acc, m) => { acc[m.id] = m; return acc }, {}),
                        whtRate,
                        whtAccount,
                        lastYearWhtAccount,
                        pluginData
                    })
                } catch (err) {
                    log.error(fn, `India WHT path threw: ${err.message}. ${err.stack || ''}`)
                }
            }
        }
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
        return tblaCashAppCommon.changeCashAppCustomer(cashAppTransactionId, customerId, pluginData)
    }

    /**
     * Resolves dynamic memo templates and optionally sets them on a record.
     * Exposed so that PRI_CashApp_Common can call it for non-payment records
     * (e.g. customer deposits) that bypass beforeCreatePayment.
     */
    function resolvePaymentMemos(rec, cashAppTransactionId, matches, pluginData) {
        return tblaCashAppCommon.setPaymentMemos(rec, cashAppTransactionId, matches, pluginData)
    }

    /* ====================================================================================================== */

    return {
        getCashAppTransactions,
        newCashAppTransaction,
        matchCashAppTransaction,
        autoApplyCashAppTransaction,
        createCashAppMatchingRules,
        sortMatchedTransactions,
        createWriteOffTransaction,
        beforeCreatePayment,
        afterCreatePayment,
        changeCashAppCustomer,
        resolvePaymentMemos
    }
})