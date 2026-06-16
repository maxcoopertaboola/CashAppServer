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

    function round2(n) { return Math.round((Number(n) || 0) * 100) / 100 }

    /**
     * Computes the Thailand WHT amount, WHT base, and cash portion for a single
     * applied match, scaling by the partial-apply ratio (apply / total).
     *
     * Rationale (see PTM28554 partial-WHT example):
     *   - Customer pays gross-of-VAT minus the WHT they self-withhold:
     *       expectedCash  = total − subtotal × whtRate
     *   - The amount applied to close the invoice ("apply") is gross
     *     (bank cash + WHT credit). The proportion of the invoice closed is
     *     apply / total, and the same proportion governs both the taxable
     *     base recognised on this payment and the WHT credited:
     *       whtBase   = subtotal × (apply / total)
     *       whtAmount = whtBase  × (whtRate / 100)
     *       cashPart  = apply    − whtAmount
     *
     * For a fully applied invoice (apply ≈ total) we use the raw subtotal as
     * the base to avoid sub-cent rounding loss; for a partial apply we round
     * the WHT amount to currency precision first and derive the WHT base from
     * the rounded WHT (so whtBase × whtRate is internally consistent and
     * matches the accounting rounding convention used downstream).
     *
     * Honors UI overrides:
     *   - tblaWht.whtMarkup       → explicit WHT amount
     *   - tblaWht.baseApplyAmount → explicit cash portion
     *
     * @param {Object} match
     * @param {number} match.apply    Gross apply amount (cash + WHT)
     * @param {number} match.total    Invoice foreign total
     * @param {number} match.subtotal Invoice net of tax
     * @param {Object} [match.tblaWht]
     * @param {number} whtRate        WHT rate as a percentage (e.g. 2 for 2%)
     * @param {Object} [fallback]     { subtotal, total } used when match lacks them
     * @returns {{ whtBase:number, whtAmount:number, cashPart:number }}
     */
    function computeTHWhtForMatch(match, whtRate, fallback = {}) {
        const parsed = safeParseTblaWht(match && match.tblaWht)
        const subtotal = (match && match.subtotal != null)
            ? Number(match.subtotal)
            : Number(fallback.subtotal || 0)
        const total = (match && match.total != null && match.total !== 0)
            ? Number(match.total)
            : Number(fallback.total || 0)
        const apply = Number((match && match.apply) || 0)
        const rateFraction = whtRate ? (Number(whtRate) / 100) : 0

        // Manual override from the UI: whtMarkup is the WHT amount; back the
        // base out from it. baseApplyAmount, if present, is the cash portion.
        if (parsed && parsed.whtMarkup != null) {
            const whtAmount = round2(parsed.whtMarkup)
            const whtBase = rateFraction ? round2(whtAmount / rateFraction) : subtotal
            const cashPart = parsed.baseApplyAmount != null
                ? round2(parsed.baseApplyAmount)
                : round2(apply - whtAmount)
            return { whtBase, whtAmount, cashPart }
        }

        // No rate or no taxable subtotal — nothing to withhold.
        if (!rateFraction || subtotal <= 0) {
            return { whtBase: 0, whtAmount: 0, cashPart: round2(apply) }
        }

        const isFullApply = (total <= 0) || (apply >= total - 0.01)
        if (isFullApply) {
            const whtBase = subtotal
            const whtAmount = round2(subtotal * rateFraction)
            return { whtBase, whtAmount, cashPart: round2(apply - whtAmount) }
        }

        const ratio = Math.max(0, apply / total)
        const whtAmount = round2(subtotal * rateFraction * ratio)
        const whtBase = round2(whtAmount / rateFraction)
        const cashPart = round2(apply - whtAmount)
        return { whtBase, whtAmount, cashPart }
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
        const fn = `${scriptName}.matchCashAppTransaction`,
            addendaLines = tblaCashAppCommon.getAddendaDetails(transactionData, pluginData)
        log.debug(fn, {addendaLines})

        // FX context: when the cashapp transaction carries a foreignCurrency
        // (custrecord_pri_cashapp_trans_foreigncur), the memo-referenced
        // invoices are in that foreign currency while `paymentAmount` is in
        // the subsidiary's base currency. Compare invoice.unpaid against
        // foreignRemitAmount in that case so an FX cashapp can still match an
        // invoice in its own currency.
        let fxLookup = null
        try {
            if (transactionData && transactionData.id) {
                fxLookup = search.lookupFields({
                    type:'customrecord_pri_cashapp_transaction',
                    id: transactionData.id,
                    columns: [
                        'custrecord_pri_cashapp_trans_foreigncur',
                        'custrecord_pri_cashapp_trans_foreignamt'
                    ]
                })
            }
        } catch (err) {
            log.error(`${fn}: FX lookup failed`, err.message)
        }
        const hasForeignCur = !!(fxLookup
            && fxLookup.custrecord_pri_cashapp_trans_foreigncur
            && fxLookup.custrecord_pri_cashapp_trans_foreigncur[0]
            && fxLookup.custrecord_pri_cashapp_trans_foreigncur[0].value)
        const foreignAmtNum = parseFloat(fxLookup && fxLookup.custrecord_pri_cashapp_trans_foreignamt)
        const basePaymentAmount = parseFloat(parseFloat((transactionData && transactionData.paymentAmount) || 0).toFixed(2))
        const compareAmount = (hasForeignCur && !isNaN(foreignAmtNum) && foreignAmtNum > 0)
            ? parseFloat(foreignAmtNum.toFixed(2))
            : basePaymentAmount

        // There are 2 types of matches to be added based on the data returned from getAddendaDetails:
        // 1. Invoice Number - Exact match to Invoice Number
        // 2. Invoice Reference - Match to the Invoice Reference Number
        const invoiceNumbers = [], invoiceRefs = []

        // Adds a transaction to the matches object
        const addMatch = (id, tran, ruleString, priority, increment = false, incrementAmount = 0, referenceAmount) => {
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
                    billcountry: tran?.billcountry
                }
            }
            if (referenceAmount && !isNaN(parseFloat(referenceAmount)))
                matches[id].refAmt = (parseFloat(referenceAmount||0)*100)/100
        }

        for (const line of addendaLines) {
            if (!!line.number && !invoiceNumbers.includes(line.number)) invoiceNumbers.push(line.number)
            if (!!line.ref && !invoiceRefs.includes(line.ref)) invoiceRefs.push(line.ref)
        }
        log.debug(`${fn}: Addenda Details`, {
            invoiceNumbers:invoiceNumbers.length, 
            invoiceRefs:invoiceRefs.length
        })
        
        // Compile an object of Invoice matches based on the Invoice Number
        //
        // STRICT MATCH RULE: an invoice is only registered as a priority-2
        // memo match when its unpaid balance EXACTLY equals the cashapp
        // amount we're comparing against (foreignRemitAmount when FX, else
        // base paymentAmount). This prevents the auto-apply step from
        // greedily applying a short cashapp to a larger invoice and marking
        // the cashapp APPLIED_FULL while leaving the invoice partially paid.
        const invoiceMatches = {}
        const entities = []
        let matchTotal = 0
        if (invoiceNumbers.length) {
            for (const inv of tblaCashAppCommon.queryInvoicesById(invoiceNumbers, transactionData.subsidiary)) {
                if (!entities.includes(inv.entity)) entities.push({id:inv.entity, name:inv.entityname})
                const addenda = addendaLines.filter(l => l.number === inv.tranid)
                if (!addenda || !addenda.length) continue

                const invUnpaid = parseFloat(parseFloat(inv.unpaid || 0).toFixed(2))
                if (invUnpaid !== compareAmount) continue

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

        // Compile an object of Invoice matches based on the Invoice Reference
        if (invoiceRefs.length) {
            for (const inv of tblaCashAppCommon.queryInvoicesByRefNo(invoiceRefs, transactionData.subsidiary)) {
                if (!entities.includes(inv.entity)) entities.push({id:inv.entity, name:inv.entityname})
                const addenda = addendaLines.filter(l => {
                    if (!l.ref || !inv.otherrefnum) return false
                    return inv.otherrefnum.toString() == l.ref.toString()
                })
                if (!addenda || !addenda.length) continue

                const invUnpaid = parseFloat(parseFloat(inv.unpaid || 0).toFixed(2))
                if (invUnpaid !== compareAmount) continue

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
        
        // Add all Invoice Matches to the matches object
        let invoiceMatchCount = 0
        for (const id in invoiceMatches) {
            tblaCashAppCommon.addCashAppMatch(matches, id, invoiceMatches[id], 'Taboola Addenda Matching', 2)
            ++invoiceMatchCount
        }

        // NOTE: The previous behavior here added every open invoice for the
        // single matched customer as a priority-3 'Taboola Customer Match'
        // candidate, which polluted the candidate set with invoices that were
        // never referenced in the bank addenda memo. The candidate set is now
        // restricted to memo-matched invoices (priority 2) plus the optional
        // fuzzy fallback below — anything else must be applied manually.

        // If no addenda matches at this point, try a modified fuzzy match based on the customer name
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
        // Gate: batch setup regime === '1' (Thailand) AND a non-zero whtRate is
        // provided on the cash app transaction. The invoice's billcountry is
        // intentionally NOT consulted — the regime configured on the batch and
        // the rate on the transaction are the source of truth.
        const whtRate = fields?.taboolaWHTData?.rate
        const isThailandRegime = String(setup?.taboolaWHTRegime) === '1'
        const hasWhtRate = !!whtRate && !isNaN(parseFloat(whtRate))
        if (isThailandRegime && hasWhtRate) {
            const thWhtMatches = Object.values(matches).filter(m => m.apply > 0)
            log.debug(fn, {thWhtMatches})
            const thWhtIds = thWhtMatches.map(m => m.tranid)
            const thWhtInvoices = tblaCashAppCommon.queryInvoicesById(thWhtIds, subsidiary, false)

            let whtAmount = 0, totalInvTax = 0, totalPayment = 0
            if (thWhtMatches.length > 0) {
                totalInvTax = thWhtInvoices.reduce((acc, inv) => acc + (inv.taxamount || 0), 0)

                const invByTranid = {}
                thWhtInvoices.forEach(inv => { invByTranid[inv.tranid] = inv })

                // PTM28554 partial-WHT: scale WHT amount and cash portion by
                // (apply / total) per match instead of using the full invoice WHT.
                for (const m of thWhtMatches) {
                    const inv = invByTranid[m.tranid]
                    const fallback = {
                        subtotal: inv && inv.totalnetoftax,
                        total: inv && inv.total
                    }
                    const { whtAmount: w, cashPart: c } = computeTHWhtForMatch(m, whtRate, fallback)
                    whtAmount += w
                    totalPayment += c
                }
                whtAmount = round2(whtAmount)
                totalPayment = round2(totalPayment)

                paymentRec.setValue({fieldId:'custbody_invoice_type', value:'2'})  // Intentionaly Hard-coded Payment Type for WHT
                paymentRec.setValue({fieldId:'custbody_tax_code_body', value:'1002'})  // Intentionaly Hard-coded Payment Type for WHT
                paymentRec.setValue({fieldId:'custbody_taxamt', value:totalInvTax})

                paymentRec.setValue({fieldId:'custbody_journal_type', value:'3'}) // Intentionaly Hard-coded Payment Type for WHT
                paymentRec.setValue({fieldId:'custbody_chk_submit_customgl', value:true}) // Intentionaly Hard-coded Custom GL for WHT
                paymentRec.setValue({fieldId:'custbody_total_payment', value:totalPayment})
                paymentRec.setValue({fieldId:'custbody_total_wh_tax', value:whtAmount})
            }
        }

        // Taboola Cash App Transaction - Create a Payment using a Netting Account
        // try {
        // const [nettingPayment, nettingAccount] = tblaCashAppCommon.createCurrencyNettingPayment(
        //     batchId, cashAppTransactionId, fields, matches, pluginData)
        // if (!!nettingPayment && !!nettingAccount) {
        //     log.debug(fn, `Setting Payment Account to Netting Account: ${nettingAccount}`)
        //     paymentRec.setValue({fieldId:'undepfunds',value:'F'})
        //     paymentRec.setValue({fieldId:'account',value:nettingAccount})
        //     return true
        // }
        // } catch (err) {
        //     log.error(fn, `Failed to create Currency Netting Payment. ${err.message}. ${err.stack}`)
        // }

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

        // Per-match summary of what reaches afterCreatePayment. Promoted to
        // audit level so the gating values and per-match billcountry / apply /
        // subtotal / total are always visible when investigating why a WHT
        // payment did or didn't fire (PTM28554 partial-WHT investigation).
        const matchSummary = Object.values(matches || {}).map(m => ({
            id: m && m.id,
            apply: m && m.apply,
            billcountry: (m && m.billcountry) || null,
            subtotal: m && m.subtotal,
            total: m && m.total,
            currency: m && m.currency,
            entity: m && m.entity,
            payment: m && m.payment || null
        }))
        log.audit(fn, JSON.stringify({
            label: 'WHT gating values',
            isDummyPayment: !!fields.isDummyPayment,
            regime: setup?.taboolaWHTRegime,
            regimeText: setup?.taboolaWHTRegimeText,
            whtRate,
            certificateNumber,
            whtAccount,
            lastYearWhtAccount,
            subsidiary,
            matchCount: matchSummary.length,
            matchSummary
        }))

        // Gating policy (PTM28554): the WHT branch to run is determined ONLY by
        //   1. the regime configured on the batch setup (custrecord_tb_wht_regime)
        //   2. the WHT rate provided on the cash app transaction (custrecord_tb_wht_rate)
        // The invoice's billcountry is no longer used as a filter — every match
        // with apply > 0 is processed using the regime's logic.
        const isThailandRegime = String(setup?.taboolaWHTRegime) === '1'
        const isIndiaRegime    = String(setup?.taboolaWHTRegime) === '2'
        const hasWhtRate       = !!whtRate && !isNaN(parseFloat(whtRate))

        if (!fields.isDummyPayment && !!setup?.taboolaWHTRegime && hasWhtRate) {
            const whtMatchesAll = Object.values(matches).filter(m => m.apply > 0)

            // Thailand WHT
            if (isThailandRegime) {
                if (whtMatchesAll.length === 0) {
                    log.audit(fn, `Thailand WHT skipped: no matches with apply>0.`)
                } else {
                    // PTM28554 partial-WHT: WHT base posted to the custom GL must be
                    // the partial taxable base (subtotal × apply/total per match),
                    // not the full invoice subtotal.
                    let whtAmount = 0, totalBase = 0
                    for (const m of whtMatchesAll) {
                        const { whtAmount: w, whtBase: b } = computeTHWhtForMatch(m, whtRate)
                        whtAmount += w
                        totalBase += b
                    }
                    whtAmount = round2(whtAmount)
                    totalBase = round2(totalBase)

                    log.audit(fn, `Thailand WHT: matches=${whtMatchesAll.length}, totalBase=${totalBase}, whtAmount=${whtAmount}, whtRate=${whtRate}`)

                    // Create customrecord_custom_gl_wh_custpayment record
                    const rec = record.create({type:'customrecord_custom_gl_wh_custpayment'})
                    rec.setValue({fieldId:'custrecord_cgl_cp_tran_ref', value:pymtId})
                    rec.setValue({fieldId:'custrecord_cgl_cp_account', value:whtAccount})
                    rec.setValue({fieldId:'custrecord_cgl_cp_tax_rate', value:whtRate})
                    rec.setValue({fieldId:'custrecord_cgl_cp_foreign_base', value:totalBase})
                    rec.setValue({fieldId:'custrecord_cgl_cp_tax_base', value:totalBase})

                    rec.setValue({fieldId:'custrecord_cgl_cp_foreign_amount', value:whtAmount})
                    rec.setValue({fieldId:'custrecord_cgl_cp_amount', value:whtAmount})
                    rec.setValue({fieldId:'custrecord_cgl_cp_wh_date', value:tblaCashAppCommon.formatDate(fields.date)})
                    rec.setValue({fieldId:'custrecord_cgl_cp_subsidiary', value:subsidiary})
                    rec.setValue({fieldId:'custrecord_cgl_cp_wh_no', value:certificateNumber})
                    const customGLId = rec.save()
                    log.audit(fn, `Thailand WHT custom GL ${customGLId} created.`)

                    // Blind-save payment
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
            }

            // India WHT
            // Delegates to the shared helper in TB_CashApp_Common which applies
            // the per-invoice rounding rule engine AND splits matches by
            // Indian fiscal-year boundary (01.04.YYYY – 31.03.YYYY+1, keyed to
            // today's system date) so invoices dated before the current FY
            // post to lastYearWhtAccount and the rest post to whtAccount.
            // Wrapped in try/catch so any throw inside the WHT path is
            // attributed here instead of being swallowed by the bundle's
            // generic afterCreatePayment try/catch.
            if (isIndiaRegime) {
                try {
                    tblaCashAppCommon.processIndiaWHTPayments({
                        batchId,
                        cashAppTranId,
                        fields,
                        matches,
                        whtRate,
                        whtAccount,
                        lastYearWhtAccount,
                        pluginData
                    })
                } catch (err) {
                    log.error(fn, `India WHT path threw: ${err.message}. ${err.stack || ''}`)
                }
            }
        } else if (!fields.isDummyPayment && !!setup?.taboolaWHTRegime && !hasWhtRate) {
            // Regime is configured but no WHT rate was supplied — skip WHT and
            // surface a single line so this is obvious in logs.
            log.audit(fn, `WHT skipped: regime '${setup.taboolaWHTRegime}' is set but whtRate is '${whtRate}'. ` +
                `Provide custrecord_tb_wht_rate on the Cash App Transaction to enable WHT.`)
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