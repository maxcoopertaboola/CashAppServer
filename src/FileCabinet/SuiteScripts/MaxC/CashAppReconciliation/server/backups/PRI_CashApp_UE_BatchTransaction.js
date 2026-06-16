//-----------------------------------------------------------------------------------------------------------
// Copyright 2024, All rights reserved, Prolecto Resources, Inc.
//
// No part of this file may be copied or used without express, written permission of Prolecto Resources, Inc.
//-----------------------------------------------------------------------------------------------------------
//-----------------------------------------------------------------------------------------------------------
// Description: Provides visiual customizations on the PRI CashApp Transaction record
//              Also provides a custom interface to allow users to manually match to native transactions.
//-----------------------------------------------------------------------------------------------------------
// Version History
// 20240328 Jeff Dennis PTM20064
// 20250926 Jeff Dennis PTM24443 - Updated for CashApp backups.
// 20251022 Jeff Dennis PTM26433 - Bug fix.
// 20251212 Jeff Dennis PTM26433 - Added foreign currency support.
// 20260311 Jeff Dennis PTM28554 - Universal Date format support
// 20260312 Jeff Dennis PTM28554 - Added Void button
// 20260317 Jeff Dennis PTM28554 - Added WHT Support.
//
//-----------------------------------------------------------------------------------------------------------

/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @see https://system.netsuite.com/app/help/helpcenter.nl?fid=section_4387799721.html&whence=
 */
define([
    'N/log',
    'N/runtime',
    'N/config',
    'N/search',
    'N/query',
    'N/ui/serverWidget',
    'N/ui/message',
    './PRI_CashApp_Common',
], function(log, runtime, config, search, suiteQL, ui, uiMessage, cashApp) {
    const scriptName = 'PRI_CashApp_UE_BatchTransaction'
    
    const SUBLIST_ID = 'custpage_list_match'

    /* ====================================================================================================== */

    /**
     * Runs before UI load (right after database query)
     * @param {Object} context - User Event Context
     */
    function beforeLoad(context) {
        const fn = `${scriptName}.beforeLoad`
        const { UserEventType, type, request, form, newRecord } = context,
            { ContextType, executionContext } = runtime

        if (ContextType.USER_INTERFACE === executionContext && [UserEventType.EDIT,UserEventType.VIEW].includes(type)) {
            log.debug(fn, '======================= BEFORE LOAD =======================')

            const container = 'custpage_tab_match'

            const settings = config.load({type:config.Type.USER_PREFERENCES})
            form.addField({id:'custpage_date_preference', label:'Date Preference', type:ui.FieldType.TEXT})
                .updateDisplayType({displayType:ui.FieldDisplayType.HIDDEN})
                .defaultValue = settings.getValue({fieldId:'DATEFORMAT'})
            
            const dummyPaymentId = newRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_dummypymt'})
            let linkedDummyPaymentApplications = []
            try {
                linkedDummyPaymentApplications = runQuery(`
                    select count(*) as count
                    from nexttransactionlink
                    where nextdoc = ${dummyPaymentId}
                    and linktype = 'Payment'
                `)
            } catch (err) {
                log.error(fn, `Failed to get linked dummy payment applications. ${err.message}`)
            }
            if (UserEventType.EDIT === type && linkedDummyPaymentApplications.length > 0 && linkedDummyPaymentApplications[0]?.count > 0) {
                const dummyPaymentName = newRecord.getText({fieldId:'custrecord_pri_cashapp_trans_dummypymt'})
                throw new Error(`Dummy payment ${dummyPaymentName} has been applied to other invoices. Cannot modify Cash App Transaction directly. Please modify the dummy payment directly instead.`)
            }

            setDebugFieldsHidden(request, form)
            renderCustomStatusLabel(form, newRecord)
            
            if (UserEventType.VIEW === type && linkedDummyPaymentApplications.length > 0 && linkedDummyPaymentApplications[0]?.count > 0) {
                const dummyPaymentName = newRecord.getText({fieldId:'custrecord_pri_cashapp_trans_dummypymt'})
                renderAppliedDummyPaymentBanner(form, newRecord, dummyPaymentId, dummyPaymentName)
            } else {
                renderIssuesBanner(form, newRecord)
            }

            renderUIMatchSublist(context, container)

            renderCurrencyExchangeRate(form, newRecord)

            // Load payments & invoices
            const {
                batchId,
                amountRemaining,
                bankFee,
                currency,
                foreignCurrency,
                defaultCurrency,
                foreignAmount,
                foreignAmountCalculated,
                fxDifference,
                exchangeRate,
                matches
            } = getCurrentMatchData(context)

            const currencyCode = newRecord.getValue({fieldId:'custrecord_pri_cashapp_trns_currencycode'})
            const writeOffAmount = getWriteOffAmount(batchId)

            // note: this must be called after renderUIMatchSublist
            renderAmountRemainingAndWriteOffFields(form, container, amountRemaining, writeOffAmount, {
                exchangeRate,
                defaultCurrency,
                currencyCode,
                foreignCurrency,
                foreignAmount,
                foreignAmountCalculated,
                fxDifference
            })
            populateUIMatchSublist(context, matches)

            if (type === UserEventType.VIEW) {
                renderMoveBalanceToCustomerButton(form, newRecord)
                renderMoveBalanceToDepositButton(form, newRecord)
                // 20260109 Jeff Dennis PTM28085 - Removed write off overpayment button as overpayment functionality not used.
                // renderWriteOffOverpaymentButton(form, newRecord)
                taboolaRenderVoidButton(form, newRecord)
            }
        }
    }

    /* ====================================================================================================== */

    /**
     * Updates the custrecord_pri_cashapp_trans_matches field based on the submitted custom UI Sublist data
     * @param {Object} context - User Event Context
     */
    function beforeSubmit(context) {
        const fn = `${scriptName}.beforeSubmit`
        const { UserEventType, type, newRecord, oldRecord } = context,
            { ContextType, executionContext } = runtime

        if (ContextType.USER_INTERFACE === executionContext && type !== UserEventType.DELETE) {
            log.debug(fn, '======================= BEFORE SUBMIT =======================')
            taboolaValidateWHTRate(newRecord)
            syncMatchedTransactionsData(context)        
        }    
    }

    /* ====================================================================================================== */

    /**
     * Runs after the record is submitted to the database
     * @param {Object} context - User Event Context
     */
    function afterSubmit(context) {
        const fn = `${scriptName}.afterSubmit`
        const { UserEventType, type, newRecord, oldRecord } = context,
            { ContextType, executionContext } = runtime

        // If updating in the UI: 
        // 1. try to apply any pending payment(s)
        // 2. update the matching status & matching issues
        if (ContextType.USER_INTERFACE === executionContext && UserEventType.DELETE !== type) {
            log.debug(fn, '======================= AFTER SUBMIT =======================')
            // get parsed writeoff data
            let woData = null
            try { woData = JSON.parse(newRecord.getValue({fieldId:'custpage_writeoff'})) }
            catch(_){}

            // Get the sum of the transactions to be applied
            let applyTotal = 0
            const sublistId = SUBLIST_ID
            for (let line=0; line < newRecord.getLineCount({sublistId}); ++line) {
                const apply = newRecord.getSublistValue({sublistId, line, fieldId:`${sublistId}_apply`})
                if (!isNaN(parseFloat(apply)))
                    applyTotal += parseFloat(parseFloat(apply).toFixed(2))
            }

            // Taboola: Get WHT Amount
            const whtRate = parseFloat(newRecord.getValue({fieldId:'custrecord_tb_wht_rate'}))
            const certificateNumber = newRecord.getValue({fieldId:'custrecord_tb_wht_cert_no'})

            cashApp.applyCashAppTransaction(newRecord.id, woData, {rate:whtRate, certificateNumber})

            if (oldRecord?.getValue('custrecord_pri_cashapp_trans_customer') != newRecord.getValue('custrecord_pri_cashapp_trans_customer')) {
                cashApp.changeCashAppTransactionCustomer(newRecord.id, newRecord.getValue('custrecord_pri_cashapp_trans_customer'))
            }
        }
    }
    
    /* ====================================================================================================== */
    //#region Private methods

    // Gets the current transaction data from NetSuite and applies it to the stored Match object
    function getCurrentMatchData(context) {
        const fn = `${scriptName}.getCurrentMatchData`

        // Get record fields
        const rec = context.newRecord,
            paymentAmount = parseFloat(rec.getValue({fieldId:'custrecord_pri_cashapp_trans_amount'})),
            foreignAmount = parseFloat(rec.getValue({fieldId:'custrecord_pri_cashapp_trans_foreignamt'})),
            foreignCurrency = rec.getText({fieldId:'custrecord_pri_cashapp_trans_foreigncur'}),
            foreignAmountCalculated = parseFloat(rec.getValue({fieldId:'custpage_foreign_amount_calculated'})),
            fxDifference = parseFloat(rec.getValue({fieldId:'custpage_fx_difference'})),
            // Taboola Cash App Transaction - Editable Exchange Rate
            // exchangeRate = parseFloat(rec.getValue({fieldId:'custpage_currency_exchange_rate'})),
            exchangeRate = parseFloat(rec.getValue({fieldId:'custrecord_pri_cashapp_trans_exchrate'})),
            dummyPymt = rec.getValue({fieldId:'custrecord_pri_cashapp_trans_dummypymt'}),
            bankFee = rec.getValue({fieldId:'custrecord_pri_cashapp_trans_bankfee'}),
            batchId = rec.getValue({fieldId:'custrecord_pri_cashapp_trans_batch'}),
            currency = rec.getValue({fieldId:'custrecord_pri_cashapp_trns_currencycode'})
            
        const defaultCurrency = search.lookupFields({
            type:'customrecord_pri_cashapp_batch',
            id:batchId,
            columns:[ 'custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_currency' ]
        })?.['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_currency']?.[0]?.text

        // Get current match data
        let matches = {}
        try { matches = JSON.parse(rec.getValue({fieldId:'custrecord_pri_cashapp_trans_matches'})) }
        catch(_){}

        try {
          const q = suiteQL.runSuiteQL({query:`select id from transaction where id in (${Object.keys(matches).map(k => parseInt(k)).join(',')})`}).asMappedResults()
          if (q.length) {
            Object.keys(matches).forEach(k => {
              const key = parseInt(k)
              if (!q.find(k => k.id === key)) {
                delete matches[k]
              }
            })
          }
        } catch (_) {}
        
        // Query current payments & invoice status
        const payments = cashApp.queryPaymentsAndWriteOffs(rec.id),
            invoices = cashApp.queryMatchedTransactionData(Object.keys(matches), `${scriptName}_${rec.id||'new'}`),
            amountRemaining = getAmountUnapplied(dummyPymt,paymentAmount)

        // Mutate matches with up-to-date data
        matches = updateMatchDataObject(matches, invoices, payments)

        return {
            batchId,
            amountRemaining,
            bankFee,
            currency,
            defaultCurrency,
            foreignCurrency,
            foreignAmount,
            foreignAmountCalculated,
            fxDifference,
            exchangeRate,
            matches
        }
    }

    // Used on beforeLoad and beforeSubmit to mutate the match data object
    function updateMatchDataObject(matches, invoices, payments) {
        const fn = `${scriptName}.updateMatchDataObject`
        // if (typeof matches !== 'object' || !Object.keys(matches).length) 
        //     return matches

        log.debug(fn, `${Object.keys(matches).length} matches to process.`)
        // Mutate matches with up-to-date data
        for (const k in matches) {
            const match = matches[k],
                invoice = !!invoices && invoices.filter(i => i.id == parseInt(match.id))[0],
                payment = !!payments && payments.filter(p => p.apply_id == parseInt(match.id))[0]
            if (!!invoice) {
                if (!!invoice.type)
                    match.type = invoice.type
                match.entity = invoice.entity
                match.entityname = invoice.entityname
                match.tranid = invoice.tranid
                match.trandate = invoice.trandate
                if (!!invoice?.billcountry)
                    match.billcountry = invoice?.billcountry
                match.subtotal = invoice?.subtotal ?? invoice?.totalnetoftax
                match.total = invoice.total
                match.unpaid = invoice.unpaid
                match.statuslabel = invoice.statuslabel
                match.status = invoice.status
                match.subsidiary = invoice.subsidiary
                match.currency = invoice.currency
            }
            if (!!payment) {
                match.apply = payment.apply_amount
                match.payment = payment.id
            }
        }
        return matches
    }

    // Returns the amount to apply field
    function getAmountUnapplied(dummyPymtId, paymentAmount) {
        const fn = `${scriptName}.getAmountUnapplied`
        dummyPymtId = !!dummyPymtId && !isNaN(parseInt(dummyPymtId)) && parseInt(dummyPymtId) || -1
        if (dummyPymtId < 0) return paymentAmount
        const lookup = search.lookupFields({type:'customerpayment',id:dummyPymtId,columns:['fxamount']})
        return !!lookup.fxamount && !isNaN(parseFloat(lookup.fxamount)) 
            && parseFloat(lookup.amount) || paymentAmount
    }

    // Returns the configured write-off amount
    function getWriteOffAmount(batchId) {
        const fn = `${scriptName}.getWriteOffAmount: ${batchId}`
        if (!!batchId) {
            try {
                const lookup = search.lookupFields({
                    type:'customrecord_pri_cashapp_batch',
                    id:batchId,
                    columns:[
                        'custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_writeoffamt'
                    ]
                })
                return !!lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_writeoffamt']
                    && parseFloat(lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_writeoffamt'])
                    || 0
            } catch (err) {}
        }
        return null
    }

    function renderCurrencyExchangeRate(form, newRecord) {
        const fn = `${scriptName}.renderCurrencyExchangeRate`
        if (!form || !newRecord) return
        const date = newRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_date'})
        if (!date) return

        const currency = newRecord.getValue({fieldId:'custrecord_pri_cashapp_trns_currencycode'})
        const batchId = newRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_batch'})
        const defaultCurrency = search.lookupFields({
            type:'customrecord_pri_cashapp_batch',
            id:batchId,
            columns:[ 'custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_currency' ]
        })?.['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_currency']?.[0]?.text

        const defaultCurrencyField = form.addField({id:'custpage_default_currency', label:'Default Currency', type:ui.FieldType.TEXT})
        defaultCurrencyField.updateDisplayType({displayType:ui.FieldDisplayType.HIDDEN})
        defaultCurrencyField.defaultValue = defaultCurrency ?? ''
        
        const foreignCur = newRecord.getText({fieldId:'custrecord_pri_cashapp_trans_foreigncur'})
        if (!foreignCur) return
        
        // Taboola Cash App Transaction - Editable Exchange Rate
        const exchangeRateField = form.getField({id:'custrecord_pri_cashapp_trans_exchrate'})
        const exchangeRate = cashApp.getCurrencyExchangeRate(date, currency, foreignCur, defaultCurrency)
        if (!exchangeRate) {
            exchangeRateField.updateDisplayType({displayType:ui.FieldDisplayType.HIDDEN})
        }

        defaultCurrencyField.updateDisplayType({displayType:ui.FieldDisplayType.INLINE})
        form.insertField({field:defaultCurrencyField, nextfield:'custrecord_pri_cashapp_trans_bankfee'})
        
        // Taboola Cash App Transaction - Editable Exchange Rate
        // const exchangeRateField = form.addField({id:'custpage_currency_exchange_rate', label:'Currency Exchange Rate', type:ui.FieldType.TEXT})
        // exchangeRateField.updateDisplayType({displayType:ui.FieldDisplayType.INLINE})
        exchangeRateField.defaultValue = exchangeRate
        form.insertField({field:exchangeRateField, nextfield:'custrecord_pri_cashapp_trans_bankfee'})

        const amount = newRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_amount'})
        // const foreginAmountCalculated = Math.round(amount / exchangeRate * 100) / 100
        // foreginAmountField.updateDisplayType({displayType:ui.FieldDisplayType.INLINE})

        // const foreginAmountField = form.addField({id:'custpage_foreign_amount_calculated', label:'Foreign Amount Calculated', type:ui.FieldType.CURRENCY})
        // foreginAmountField.defaultValue = foreginAmountCalculated
        // form.insertField({field:foreginAmountField, nextfield:'custrecord_pri_cashapp_trans_bankfee'})

        const foreignAmount = newRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_foreignamt'})
        // if (foreignAmount) {
        //     const fxDifference = Math.round((foreignAmount - foreginAmountCalculated) * 100) / 100
        //     const fxDifferenceField = form.addField({id:'custpage_fx_difference', label:'FX Difference', type:ui.FieldType.CURRENCY})
        //     fxDifferenceField.updateDisplayType({displayType:ui.FieldDisplayType.INLINE})
        //     fxDifferenceField.defaultValue = fxDifference
        //     form.insertField({field:fxDifferenceField, nextfield:'custrecord_pri_cashapp_trans_bankfee'})
        // }
        
        return exchangeRate
    }

    // Renders the custom 'Match Transactions' sublist for manual cash application (view & edit in UI only)
    function renderUIMatchSublist(context, container) {
        const fn = `${scriptName}.renderUIMatchSublist`,
            { UserEventType, type, request, form, newRecord } = context,
            isViewMode = UserEventType.VIEW === type

        // General constants
        const label = 'Match Transactions',
            sublistId = SUBLIST_ID

        // Create the tab
        const tab = form.addTab({id:container, label})
        form.insertTab({tab, nexttab:form.getTabs()[0]})

        // Create the sublist
        const sublist = form.addSublist({id:sublistId, label, tab:container, type:ui.SublistType.INLINEEDITOR})

        // Add tab action buttons (edit mode)
        sublist.addButton({id:`${sublistId}_findtransactions`, label:'Find Transactions', functionName:'findTransactions'})
        sublist.addButton({id:`${sublistId}_btnautoapply`, label:'Auto Apply', functionName:'autoApply'})
        sublist.addButton({id:`${sublistId}_clearamounts`, label:'Clear Amounts', functionName:'clearAmounts'})

        // Add in the client script file for button callbacks
        form.clientScriptModulePath = './PRI_CashApp_CL_BatchTransaction'

        // Add sublist fields
        const fld_autoapply = sublist.addField({id:`${sublistId}_autoapply`, label:'Auto-Apply', type:ui.FieldType.CHECKBOX}),
            fld_locked = sublist.addField({id:`${sublistId}_locked`, label:'Locked', type:ui.FieldType.CHECKBOX}),
            fld_id = sublist.addField({id:`${sublistId}_id`, label:'Transaction', type:ui.FieldType.SELECT, source:'invoice'}),
            fld_prio = sublist.addField({id:`${sublistId}_prio`, label:'Priority', type:ui.FieldType.INTEGER}),
            fld_customer = sublist.addField({id:`${sublistId}_customer`, label:'Customer', type:ui.FieldType.TEXT}),
            fld_customerval = sublist.addField({id:`${sublistId}_customerval`, label:'Customer Value', type:ui.FieldType.INTEGER}),
            fld_customerview = sublist.addField({id:`${sublistId}_customerview`, label:'Customer', type:ui.FieldType.SELECT, source:'customer'}),
            fld_date = sublist.addField({id:`${sublistId}_date`, label:'Date', type:ui.FieldType.DATE}),
            fld_statusval = sublist.addField({id:`${sublistId}_statusval`, label:'Status Value', type:ui.FieldType.TEXT}),
            fld_status = sublist.addField({id:`${sublistId}_status`, label:'Status', type:ui.FieldType.TEXT}),
            fld_billcountry = sublist.addField({id:`${sublistId}_billcountry`, label:'Billing Country', type:ui.FieldType.TEXT}),
            fld_subtotal = sublist.addField({id:`${sublistId}_subtotal`, label:'Subtotal', type:ui.FieldType.CURRENCY}),
            fld_total = sublist.addField({id:`${sublistId}_total`, label:'Total', type:ui.FieldType.CURRENCY}),
            fld_currency = sublist.addField({id:`${sublistId}_currency`, label:'Currency', type:ui.FieldType.SELECT, source:'currency'}),
            fld_open = sublist.addField({id:`${sublistId}_open`, label:'Balance', type:ui.FieldType.CURRENCY}),
            fld_apply = sublist.addField({id:`${sublistId}_apply`, label:'Apply', type:ui.FieldType.CURRENCY}),
            fld_rule = sublist.addField({id:`${sublistId}_rule`, label:'Match Rule', type:ui.FieldType.TEXT}),
            fld_pymt = sublist.addField({id:`${sublistId}_payment`, label:'Payment', type:ui.FieldType.SELECT, source:'transaction'}),
            fld_tbla_wht = sublist.addField({id:`${sublistId}_tbla_wht`, label:'WHT', type:ui.FieldType.TEXTAREA})

        // Set sublist field display types
        fld_locked.updateDisplayType({displayType:ui.FieldDisplayType.HIDDEN})
        fld_customerval.updateDisplayType({displayType:ui.FieldDisplayType.HIDDEN})
        if (isViewMode) {
            fld_customer.updateDisplayType({displayType:ui.FieldDisplayType.HIDDEN})
            fld_customerview.updateDisplayType({displayType:ui.FieldDisplayType.DISABLED})
        } else {
            fld_customer.updateDisplayType({displayType:ui.FieldDisplayType.DISABLED})
            fld_customerview.updateDisplayType({displayType:ui.FieldDisplayType.HIDDEN})
        }
        fld_date.updateDisplayType({displayType:ui.FieldDisplayType.DISABLED})
        fld_status.updateDisplayType({displayType:ui.FieldDisplayType.DISABLED})
        fld_statusval.updateDisplayType({displayType:ui.FieldDisplayType.HIDDEN})
        fld_currency.updateDisplayType({displayType:ui.FieldDisplayType.DISABLED})
        fld_subtotal.updateDisplayType({displayType:ui.FieldDisplayType.DISABLED})
        fld_billcountry.updateDisplayType({displayType:ui.FieldDisplayType.HIDDEN})
        fld_tbla_wht.updateDisplayType({displayType:ui.FieldDisplayType.HIDDEN})
        fld_total.updateDisplayType({displayType:ui.FieldDisplayType.DISABLED})
        fld_open.updateDisplayType({displayType:ui.FieldDisplayType.DISABLED})
        fld_rule.updateDisplayType({displayType:ui.FieldDisplayType.DISABLED})
        fld_prio.updateDisplayType({displayType:ui.FieldDisplayType.HIDDEN})
        fld_pymt.updateDisplayType({displayType:ui.FieldDisplayType.DISABLED})
        if (UserEventType.EDIT !== type)
            fld_autoapply.updateDisplayType({displayType:ui.FieldDisplayType.HIDDEN})
    }

    // Populates the 'Match Transactions' tab & sublist with dynamic data (view & edit in UI only)
    function populateUIMatchSublist(context, matches) {
        const { UserEventType, type, form, newRecord } = context,
            fn = `${scriptName}.populateUIMatchSublist.${newRecord.id||'new'}`,
            isViewMode = UserEventType.VIEW === type

        const batchId = newRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_batch'})

        // Set ordered transaction sublist default values
        let line = 0
        const sublist = form.getSublist({id:SUBLIST_ID}),
            sorted = cashApp.sortMatchedTransactions(batchId, matches)

        for (const match of sorted) {
            if (match.id == null || match.id == undefined) continue;
            
            sublist.setSublistValue({line, id:`${SUBLIST_ID}_id`, value:match.id})
            if (match.entity) {
                if (isViewMode) {
                    sublist.setSublistValue({line, id:`${SUBLIST_ID}_customerview`, value:match.entity.toString()})
                } else {
                    sublist.setSublistValue({line, id:`${SUBLIST_ID}_customer`, value:match.entityname||match.entity})
                    try {
                        sublist.setSublistValue({line, id:`${SUBLIST_ID}_customerval`, value:parseInt(match.entity)})
                    }catch(e) {
                        log.error(fn, {name:e.name, message:e.message})
                    }
                }
            }
            if (match.subtotal)
                sublist.setSublistValue({line, id:`${SUBLIST_ID}_subtotal`, value:match.subtotal})
            sublist.setSublistValue({line, id:`${SUBLIST_ID}_total`, value:match.total||'0.00'})
            sublist.setSublistValue({line, id:`${SUBLIST_ID}_open`, value:match.unpaid||'0.00'})
            if (!!match.statuslabel) {
                const status = match.statuslabel.indexOf(':') > -1
                    ? match.statuslabel.split(':')[1].trim() : match.statuslabel
                sublist.setSublistValue({line, id:`${SUBLIST_ID}_status`, value:status})
            }
            if (!!match.status) {
                sublist.setSublistValue({line, id:`${SUBLIST_ID}_statusval`, value:match.status})
                if (match.status !== 'A')
                    sublist.setSublistValue({line, id:`${SUBLIST_ID}_locked`, value:'T'})
            }
            if (match.apply && match.apply > 0 && !!match.payment)
                sublist.setSublistValue({line, id:`${SUBLIST_ID}_apply`, value:match.apply})
            if (match.trandate)
                sublist.setSublistValue({line, id:`${SUBLIST_ID}_date`, value:match.trandate})
            if (match.rules && match.rules.length)
                sublist.setSublistValue({line, id:`${SUBLIST_ID}_rule`, value:match.rules.join('\r\n').slice(0,300)})
            if (match.priority)
                sublist.setSublistValue({line, id:`${SUBLIST_ID}_prio`, value:match.priority.toString()})
            if (match.payment)
                sublist.setSublistValue({line, id:`${SUBLIST_ID}_payment`, value:match.payment})
            if (match.currency)
                sublist.setSublistValue({line, id:`${SUBLIST_ID}_currency`, value:match.currency})
            if (match.billcountry)
                sublist.setSublistValue({line, id:`${SUBLIST_ID}_billcountry`, value:match.billcountry})
            else {
                const lookup = search.lookupFields({
                    type:'invoice',
                    id:match.id,
                    columns:['billcountry']
                })
                // sublist.setSublistValue({line, id:`${SUBLIST_ID}_billcountry`, value:lookup?.billcountry?.[0]?.value})
            }
            if (match.tblaWht)
                sublist.setSublistValue({line, id:`${SUBLIST_ID}_tbla_wht`, value:match.tblaWht})
            ++line
        }
    }

    // Renders the 'Amount Remaining' UI field in the given container, for the given amount
    function renderAmountRemainingAndWriteOffFields(form, container, amount, writeOffAmount, currencyConfig = {}) {
        const fn = `${scriptName}.renderAmountRemainingAndWriteOffFields`
        const { exchangeRate, currencyCode, foreignCurrency, defaultCurrency, foreignAmountCalculated } = currencyConfig || {}

        // Set the amount to apply based on given data// Add a custom amount remaining field (edit mode only)
        const amountRemaining = form.addField({id:'custpage_amount_remaining', label:'Amount to Apply', type:ui.FieldType.TEXT, container})
        amountRemaining.updateDisplayType({displayType:ui.FieldDisplayType.INLINE})
        amountRemaining.defaultValue = `${Number(amount).toFixed(2)} (${currencyCode||defaultCurrency})` || `0.00 (${currencyCode||defaultCurrency})`
        if (foreignAmountCalculated) {
            amountRemaining.defaultValue = `${Number(foreignAmountCalculated).toFixed(2)} (${foreignCurrency})`
        }
        
        // Write-off data field
        const writeOffTran = form.addField({id:'custpage_writeoff', label:'Writeoff', type:ui.FieldType.TEXTAREA, container})
        writeOffTran.updateDisplayType({displayType:ui.FieldDisplayType.HIDDEN})

        // Write-off threshold field
        const writeOffAmt = form.addField({id:'custpage_writeoff_threshold', label:'Writeoff Threshold', type:ui.FieldType.CURRENCY, container})
        writeOffAmt.updateDisplayType({displayType:ui.FieldDisplayType.HIDDEN})
        if (!!writeOffAmount)
            writeOffAmt.defaultValue = writeOffAmount
    }

    // Renders the 'Move Balance to Customer' button
    function renderMoveBalanceToCustomerButton(form, newRecord) {
        const fn = `${scriptName}.renderMoveBalanceToCustomerButton`
        const status = newRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_matchstatus'}),
            dummyPayment = newRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_dummypymt'}),
            customer = newRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_customer'})
        if (status === cashApp.MATCH_STATUS.APPLIED_FULL || !dummyPayment || !customer)
            return

        form.addButton({ id:'custpage_cashapp_movebalance', label:'Move Balance to Customer', functionName:'moveBalanceToCustomer' })
        form.clientScriptModulePath = './PRI_CashApp_CL_BatchTransaction'
    }

    // Taboola Cash App Transaction - Move Balance to Deposit
    function renderMoveBalanceToDepositButton(form, newRecord) {
        const fn = `${scriptName}.renderMoveBalanceToCustomerButton`
        const status = newRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_matchstatus'}),
            dummyPayment = newRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_dummypymt'}),
            customer = newRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_customer'})
        if (status === cashApp.MATCH_STATUS.APPLIED_FULL || !dummyPayment || !customer)
            return

        form.addButton({ id:'custpage_cashapp_movebalancedep', label:'Move Balance to Customer Deposit', functionName:'moveBalanceToCustomerDeposit' })
        form.clientScriptModulePath = './PRI_CashApp_CL_BatchTransaction'
    }

    // Taboola Cash App Transaction - Void
    function taboolaRenderVoidButton(form, newRecord) {
        const fn = `${scriptName}.taboolaRenderVoidButton`
        const status = newRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_matchstatus'}),
            dummyPayment = newRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_dummypymt'}),
            customer = newRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_customer'})
        if (status === cashApp.MATCH_STATUS.APPLIED_FULL || status === cashApp.MATCH_STATUS.ELIMINATED)
            return

        form.addButton({ id:'custpage_cashapp_tb_void', label:'Void', functionName:'taboolaVoid' })
        form.clientScriptModulePath = './PRI_CashApp_CL_BatchTransaction'
    }

    // Taboola Validate WHT Rate
    function taboolaValidateWHTRate(newRecord) {
        const fn = `${scriptName}.taboolaValidateWHTRate`

        const batchId = newRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_batch'})
        const lookup = search.lookupFields({
            type:'customrecord_pri_cashapp_batch',
            id:batchId,
            columns:['custrecord_pri_cashapp_batch_setup.custrecord_tb_wht_regime']
        })
        const whtRegime = lookup?.['custrecord_pri_cashapp_batch_setup.custrecord_tb_wht_regime']?.[0]?.value
        // Only allow validation for Thailand WHT regime
        if (!whtRegime || isNaN(parseFloat(whtRegime)) || String(whtRegime) !== '1') return

        const foreignCurrency = newRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_foreigncur'})
        const paymentAmount = !!foreignCurrency
            ? parseFloat(newRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_foreignamt'}))
            : parseFloat(newRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_amount'}))
        const exchangeRate = parseFloat(newRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_exchrate'}))

        // Get the sum of the transactions to be applied
        let applyTotal = 0
        const sublistId = SUBLIST_ID
        for (let line=0; line < newRecord.getLineCount({sublistId}); ++line) {
            const apply = newRecord.getSublistValue({sublistId, line, fieldId:`${sublistId}_apply`})
            const currency = newRecord.getSublistText({sublistId, line, fieldId:`${sublistId}_currency`})
            if (!isNaN(parseFloat(apply))) {
                applyTotal += parseFloat(parseFloat(apply).toFixed(2))
            }
        }

        // If the payment amount does not match the applied invoice amount minus the calculated WHT, throw an error
        // Allow for a small margin of error of 0.01 for rounding issues
        // TODO: 
        // if (Math.abs(paymentAmount.toFixed(2) - (parseFloat(applyTotal).toFixed(2) - whtAmount)) > 0.01) {
        //     throw new Error(`The applied invoice amount (${applyTotal.toFixed(2)}) minus the calculated WHT (${whtAmount.toFixed(2)}) does not match the actual bank receipt amount (${paymentAmount.toFixed(2)}).`)
        // }
    }

    // Renders the writeoff overpayments button
    function renderWriteOffOverpaymentButton(form, newRecord) {
        const fn = `${scriptName}.renderWriteOffOverpaymentButton`
        
        const batchId = newRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_batch'}),
            status = newRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_matchstatus'}),
            dummyPayment = newRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_dummypymt'}),
            customer = newRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_customer'})

        if (status === cashApp.MATCH_STATUS.APPLIED_FULL || !dummyPayment || !customer)
            return

        const unapplied = getAmountUnapplied(dummyPayment),
            writeOff = getWriteOffAmount(batchId)

        if (!writeOff || !unapplied || unapplied > writeOff) return

        form.addButton({ id:'custpage_cashapp_writeoff', label:'Write Off Overpayment', functionName:'writeOffOverpayment' })
        form.clientScriptModulePath = './PRI_CashApp_CL_BatchTransaction'
    }

    // Sets specified fields hidden unless the &debug=T URL parameter is set
    function setDebugFieldsHidden(request, form) {
        if (!request.parameters.debug) {
            form.getField({id:'custrecord_pri_cashapp_trans_matches'}).updateDisplayType({displayType:'HIDDEN'})
            form.getField({id:'custrecord_pri_cashapp_trans_data'}).updateDisplayType({displayType:'HIDDEN'})
        }
    }

    // Renders a custom UI status label similar to the native UI Transaction Status
    function renderCustomStatusLabel(form, rec) {
        const fn = `${scriptName}.renderCustomStatusLabel`
        // Setup a custom label if the Device Status field has a value
        // Label will display the same as NetSuite's native Transaction status labels when viewing a transaction record
        try {
            const status = rec.getText({ fieldId:'custrecord_pri_cashapp_trans_matchstatus' })
            if (status) {
                let htmlValue = `
                <script type="text/javascript">
                document.addEventListener('DOMContentLoaded', function () {
                    const statusLabel = document.createElement('div')
                    statusLabel.classList.add('uir-record-status')
                    statusLabel.style = 'margin-left:0;'
                    statusLabel.innerText = '${status}'
                    const pgTitle = document.querySelector('.uir-page-title-secondline')
                    if (pgTitle)
                        pgTitle.appendChild(statusLabel)
                    else {
                        const title1 = document.querySelector('.uir-page-title-firstline')
                        const title2 = document.createElement('div')
                        title2.classList.add('uir-page-title-secondline')
                        title2.appendChild(statusLabel)
                        title1.parentElement.appendChild(title2)
                    }
                })
                </script>`
                form.addField({ id:'custpage_status_html', label:'Status', type:'INLINEHTML' }).defaultValue = htmlValue
            }
        } catch (err) {
            log.error(`${fn}: ${err.name}`, err.message)
        }
    }

    // Renders a UI banner displaying any matcing issues for the record
    function renderIssuesBanner(form, rec) {
        const matchIssues = rec.getValue({fieldId:'custrecord_pri_cashapp_trans_matchissues'}),
            amount = rec.getValue({fieldId:'custrecord_pri_cashapp_trans_amount'}),
            currencyCode = rec.getValue({fieldId:'custrecord_pri_cashapp_trns_currencycode'}),
            totalAmountCalc = rec.getValue({fieldId:'custrecord_pri_cashapp_trans_dumypymt_c'}),
            foreignCurrency = rec.getValue({fieldId:'custrecord_pri_cashapp_trans_foreigncur'}),
            foreignAmount = rec.getValue({fieldId:'custrecord_pri_cashapp_trans_foreignamt'}),
            status = rec.getValue({fieldId:'custrecord_pri_cashapp_trans_matchstatus'})
        if (status === cashApp.MATCH_STATUS.ELIMINATED)
            return
        if (matchIssues.length) {
            let message = 'Please review the following issues on the Matched Transactions tab:'
            message += '<ol style="padding-top:.25rem;margin-left:1.5rem">'

            // Show matching issues in banner
            for (const iss of matchIssues) {
                let desc = iss
                switch(iss) {
                case cashApp.MATCH_ISSUE.NO_MATCH_FOUND:
                    desc = 'No matched transactions have been found for this record based on the <b>Customer Name</b>, <b>Customer ID</b>, or any implemented business rules.'
                    break
                case cashApp.MATCH_ISSUE.NO_MATCHING_TOTAL_FOUND:
                    desc = `Cannot find a matching open transaction where the total or open balance matches the payment amount of this record (${currencyCode} ${!!amount && amount.toFixed(2) || ''}).`
                    break
                case cashApp.MATCH_ISSUE.MATCHING_PAID_TRANSACTION:
                    desc = 'There is a potential matched transaction that has already been marked as paid.'
                    break
                case cashApp.MATCH_ISSUE.MULTIPLE_MATCHING_CUSTOMERS:
                    desc = 'There is more than one Customer that has a potential matched transaction.'
                    break
                case cashApp.MATCH_ISSUE.MATCHING_TOTAL_FOUND:
                    desc = 'A matching total was found, but a Payment was not automatically applied and created by the system.'
                    break
                case cashApp.MATCH_ISSUE.MULTIPLE_MATCHING_TOTALS_FOUND:
                    desc = 'Multiple transactions with matching totals were found. As a result, a Payment was not automatically applied and created by the system.'
                    break
                case cashApp.MATCH_ISSUE.MATCHING_PAID_FUZZY_TRANSACTION:
                    desc = 'A matching open Invoice total was found using a keyword search on Customer Name, but a Payment was not automatically applied and created by the system.'
                    break
                }
                message += `<li style="list-style:auto;padding-bottom:.125rem">${desc}</li>`
            }

            // Show validation control issues in banner
            if (!foreignCurrency && !foreignAmount && totalAmountCalc !== amount)
                message += `<li style="list-style:auto;padding-bottom:.125rem">The payment <b>Amount (${amount})</b> does not equal the computed total of <b>Customer + Dummy Payments (${totalAmountCalc})</b></li>`

            message += '</ol>'
            form.addPageInitMessage({
                type:uiMessage.Type.WARNING,
                title:'PRI CashApp found possible issues with Matched Transactions for this record',
                message
            })
        }
    }

    function renderAppliedDummyPaymentBanner(form, newRecord, dummyPaymentId, dummyPaymentName) {
        const fn = `${scriptName}.renderAppliedDummyPaymentBanner`
        form.addPageInitMessage({
            type:uiMessage.Type.ERROR,
            title:'Dummy Payment Edited Outside of Cash App',
            message: `The Dummy Payment <a href="/app/accounting/transactions/transaction.nl?id=${dummyPaymentId}" target="_blank">${dummyPaymentName}</a> for this Cash App Transaction has been manually edited outside of the Cash App. Because of this change this Cash App Transaction to not be editable directly. Please edit the Dummy Payment directly instead.`
        })
    }

    // Syncs the matched transaction sublist data back to the record before the record is submitted to the NS db
    function syncMatchedTransactionsData(context) {
        const fn = `${scriptName}.syncMatchedTransactions`,
            { UserEventType, type, newRecord, oldRecord } = context,
            sublistId = SUBLIST_ID

        // Get current match data
        let matches = {}
        try { 
            matches = JSON.parse(newRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_matches'})) 
            if (!matches) matches = {}
        }
        catch(_){}

        // get the current sublist data
        const transactions = []
        for (line=0; line< newRecord.getLineCount({sublistId}); ++line) {
            const tranId = parseInt(newRecord.getSublistValue({sublistId, line, fieldId:`${sublistId}_id`})).toFixed(0),
                subtotal = newRecord.getSublistValue({sublistId, line, fieldId:`${sublistId}_taboola_subtotal`}),
                apply = newRecord.getSublistValue({sublistId, line, fieldId:`${sublistId}_apply`}),
                billcountry = newRecord.getSublistValue({sublistId, line, fieldId:`${sublistId}_billcountry`}),
                tblaWht = newRecord.getSublistValue({sublistId, line, fieldId:`${sublistId}_tbla_wht`})
            transactions.push(tranId)
            if (!matches.hasOwnProperty(tranId)) {
                matches[tranId] = { 
                    id:parseInt(tranId),
                    type:'invoice',
                    apply:!isNaN(parseFloat(apply)) && parseFloat(apply) || null,
                    rules:['Manual']
                }
            } else if (apply == '') {
                matches[tranId].apply = null
            } else if (!isNaN(parseFloat(apply))) {
                matches[tranId].apply = parseFloat(apply)
            }
            if (!matches[tranId].billcountry && billcountry) {
                matches[tranId].billcountry = billcountry
            }
            // if (!!matches[tranId] && !!subtotal) {
            //     matches[tranId].subtotal = subtotal
            // }
            if (!!matches[tranId] && !!tblaWht) {
                matches[tranId].tblaWht = tblaWht
            }
        }
        log.debug(fn, `${Object.keys(matches).length} stored results, ${transactions.length} list results`)
        log.debug(fn, JSON.stringify({matches, transactions}))

        let payments = []
        if (type !== UserEventType.CREATE)
            payments = cashApp.queryPaymentsAndWriteOffs(newRecord.id)
        
        const invoices = cashApp.queryMatchedTransactionData(Object.keys(matches), 
                `${scriptName}_${newRecord.id||'new'}`)
        log.debug(fn, `${invoices.length} found invoices.`)

        // Update match data
        matches = updateMatchDataObject(matches, invoices, payments)
        log.debug(fn, `${Object.keys(matches).length} Matches after update.`)

        // Remove any matches that are not in the transactions Array
        for (const k in matches) {
            // if the does not exist in transactions array and does not has a priority
            // user-added matches will not have a priority and will be the only ones to be removed
            if (!~transactions.indexOf(k) && matches[k].priority === '') {
                delete matches[k]
                log.debug(fn, `Deleting matched invoice.. ${k}`)
                continue
            }
        }

        // Update custrecord_pri_cashapp_trans_matches
        log.debug(fn, JSON.stringify({matches}))
        newRecord.setValue({fieldId:'custrecord_pri_cashapp_trans_matches',value:JSON.stringify(matches)})
    }

    const runQuery = query => suiteQL.runSuiteQL({query}).asMappedResults()

    //#endregion
    /* ====================================================================================================== */

    return { 
        beforeLoad, 
        beforeSubmit, 
        afterSubmit 
    }
})
