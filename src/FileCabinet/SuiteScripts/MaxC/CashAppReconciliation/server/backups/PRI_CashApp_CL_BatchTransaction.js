//-----------------------------------------------------------------------------------------------------------
// Copyright 2024, All rights reserved, Prolecto Resources, Inc.
//
// No part of this file may be copied or used without express, written permission of Prolecto Resources, Inc.
//-----------------------------------------------------------------------------------------------------------
//-----------------------------------------------------------------------------------------------------------
// Description: Adds client-side validation and functionality for manual Cash Application matching
//-----------------------------------------------------------------------------------------------------------
// Version History
// 20240328 Jeff Dennis PTM20064
// 20250926 Jeff Dennis PTM24443 - Updated for CashApp backups.
// 20251212 Jeff Dennis PTM26433 - Added foreign currency support.
// 20260311 Jeff Dennis PTM28554 - Universal Date format support
// 20260312 Jeff Dennis PTM28554 - Added Void button
// 20260317 Jeff Dennis PTM28554 - Added WHT Support.
//-----------------------------------------------------------------------------------------------------------

/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @see https://system.netsuite.com/app/help/helpcenter.nl?fid=section_4387798404.html&whence=
 */
define([
    'N/log',
    'N/currentRecord',
    'N/search',
    'N/record',
    'N/ui/dialog',
    'N/url',
    '/.bundle/132118/modalinputs/PRI_UTIL_CL_ModalInputs.js'
], function(log, CurrentRecord, search, record, uiDialog, url, priModalInputs) {
    const scriptName = 'PRI_CashApp_CL_BatchTransaction'

    const SUBLIST_ID = 'custpage_list_match'

    /* 
        Notes: 
        ---
        Use of window.DEFAULT_MIN_AMOUNT and window.DEFAULT_MAX_AMOUNT:
        These values will pull from the configuration record and define the min/max amount used for findTransactions()

        Use of window.WRITE_OFF_AMOUNT:

        Use of window.PERFORM_AUTO_APPLY:
        This boolean flag is set to for instances when the autoApply() function is running. If this flag is set to false, 
        then auto-apply will not execute.

        window.DUMMY_PAYMENT_AMOUNT:
    */

    /* ====================================================================================================== */
    //#region Client script methods

    /**
     * Runs on initialization of a record in Edit mode
     */
    function pageInit(context) {
        const fn = `${scriptName}.pageInit`
        const { currentRecord, mode } = context
        logger(fn, context)
        initializeFindTransactionsTable(currentRecord)
        updateAmountToApply(currentRecord)
    }

    /**
     * Runs after a record field value has changed
     */
    function fieldChanged(context) {
        const fn = `${scriptName}.fieldChanged`
        const { currentRecord, fieldId, sublistId, line, column } = context
        if (sublistId === SUBLIST_ID) {
            switch (fieldId) {
            case `${sublistId}_id`:
                const transactionId = currentRecord.getCurrentSublistValue({sublistId, fieldId})
                logger(fn, context)
                sourceTransactionData(transactionId, currentRecord, sublistId)
                break
            case `${sublistId}_autoapply`:
                autoApplyCurrentLine(currentRecord)
                break
            }
        } else {
            switch (fieldId) {
            case 'custrecord_pri_cashapp_trans_foreignamt': {
                const amount = parseFloat(currentRecord.getValue({fieldId: 'custrecord_pri_cashapp_trans_amount'}))
                const foreignAmt = parseFloat(currentRecord.getValue({fieldId: 'custrecord_pri_cashapp_trans_foreignamt'}))
                if (!isNaN(amount) && !isNaN(foreignAmt) && foreignAmt !== 0) {
                    currentRecord.setValue({
                        fieldId: 'custrecord_pri_cashapp_trans_exchrate',
                        value: amount / foreignAmt,
                        ignoreFieldChange: true
                    })
                }
                updateAmountToApply(currentRecord)
                break
            }
            case 'custrecord_pri_cashapp_trans_foreigncur':
            case 'custrecord_pri_cashapp_trans_exchrate':
            case 'custrecord_pri_cashapp_trans_bankfee':
                updateAmountToApply(currentRecord)
                break
            }
        }
    }

    function validateField(context) {
        const fn = `${scriptName}.validateField`
        const { currentRecord, fieldId } = context
        logger(fn, context)

        if (fieldId === 'custrecord_pri_cashapp_trans_bankfee') {
            const value = currentRecord.getValue(context)
            if (value === '') {
                return true
            }
            if (parseFloat(value) < 0.01) {
                return false
            }
        }

        return true
    }

    /**
     * Validates the submission of a line in the record
     * @returns {boolean} True if valid
     */
    function validateLine(context) {
        const fn = `${scriptName}.validateLine`
        const { currentRecord, sublistId } = context
        logger(fn, context)

        if (sublistId === SUBLIST_ID)
            return validateApplyAmount(currentRecord, SUBLIST_ID)
        return true
    }

    /**
     * Runs right before a list is deleted
     * @returns {boolean} True if delete is allowed
     */
    function validateDelete(context) {
        const fn = `${scriptName}.validateLine`
        const { currentRecord, sublistId } = context
        logger(fn, context)
        if (sublistId === SUBLIST_ID) {
            const currLinePymt = currentRecord.getCurrentSublistValue({sublistId,fieldId:`${sublistId}_payment`})
            return !currLinePymt
        }
        return true
    }

    /**
     * Runs after a list is inserted, removed, or edited
     */
    function sublistChanged(context) {
        const fn = `${scriptName}.sublistChanged`
        const { currentRecord, sublistId } = context
        logger(fn, context)
        if (sublistId === SUBLIST_ID) {
            //updateForeignAmount(currentRecord)
            updateAmountToApply(currentRecord)
            confirmWriteOffPayments(currentRecord)
        }
    }

    //#endregion
    /* ====================================================================================================== */
    //#region Custom methods

    // Handles the 'Move Balance to Customer' button action
    function moveBalanceToCustomer() {
        const fn = `${scriptName}.moveBalanceToCustomer`
        const currentRecord = CurrentRecord.get()
        logger(fn, currentRecord)

        const loc = url.resolveScript({
            scriptId:'customscript_pri_cashapp_apply_sl',
            deploymentId:'customdeploy_pri_cashapp_apply_sl',
            params:{
                cashappid:currentRecord.id,
                movebalancetocustomer:'T'
            }
        })
        window.location.href = loc
    }

    function moveBalanceToCustomerDeposit() {
        const fn = `${scriptName}.moveBalanceToCustomerDeposit`
        const currentRecord = CurrentRecord.get()
        logger(fn, currentRecord)

        const loc = url.resolveScript({
            scriptId:'customscript_pri_cashapp_apply_sl',
            deploymentId:'customdeploy_pri_cashapp_apply_sl',
            params:{
                cashappid:currentRecord.id,
                movebalancetocustomerdeposit:'T'
            }
        })
        window.location.href = loc
    }

    // Clears all rows from the custom UI sublist
    function clearResults() {
        const fn = `${scriptName}.clearResults`
        const currentRecord = CurrentRecord.get()
        logger(fn, currentRecord)

        const sublistId = SUBLIST_ID
        for(line = currentRecord.getLineCount({sublistId}) - 1; line >= 0; --line)
            currentRecord.removeLine({sublistId, line})
    }

    // Clears amounts from the custom UI sublist
    function clearAmounts() {
        const fn = `${scriptName}.clearAmounts`
        const currentRecord = CurrentRecord.get()
        logger(fn, currentRecord)

        const sublistId = SUBLIST_ID
        window.PERFORM_AUTO_APPLY = true
        for(line = currentRecord.getLineCount({sublistId}) - 1; line >= 0; --line) {
            try {
                currentRecord.selectLine({sublistId,line})
                const payment = currentRecord.getCurrentSublistValue({sublistId,fieldId:`${sublistId}_payment`})
                if (!!payment) continue
                currentRecord.setCurrentSublistValue({sublistId,fieldId:`${sublistId}_apply`,value:'',forceSyncSourcing:true})
                currentRecord.commitLine({sublistId})
            } catch (er) {
                log.error(`${fn}: ${err.name}`, err.message)
                continue
            }
        }
        window.PERFORM_AUTO_APPLY = false
        updateAmountToApply(currentRecord)
    }

    // Finds transactions between a min/max range and copies the value to clipboard
    function findTransactions() {
        const fn = `${scriptName}.findTransactions`
        const currentRecord = CurrentRecord.get(),
            sublistId = SUBLIST_ID
        logger(fn, currentRecord)

        const batchId = currentRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_batch'})
        const setupLookup = search.lookupFields({
            type:'customrecord_pri_cashapp_batch',
            id:batchId,
            columns:['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_subsidiary']
        })
        const subsidiary = setupLookup?.['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_subsidiary']?.[0]?.value

        window.PERFORM_AUTO_APPLY = true

        !!priModalInputs && priModalInputs.showModal({
            size : 'md',
            message : 'Enter a min/max amount to search for a range of Transactions',
            title : 'Find Transactions',
            fields : [
                {
                    id:'documentnumber',
                    text:'Invoice Number',
                    type_text:'text',
                    value: ''
                },
                {
                    id:'min',
                    text:'Min Amount',
                    type_text:'number',
                    value: !!window.DEFAULT_MIN_AMOUNT && window.DEFAULT_MIN_AMOUNT.toFixed(2) || ''
                },
                {
                    id:'max',
                    text:'Max Amount',
                    type_text:'number',
                    value: !!window.DEFAULT_MAX_AMOUNT && window.DEFAULT_MAX_AMOUNT.toFixed(2) || ''
                }
            ]
        })
        .then(results => {
            console.log('confirm', results)

            let documentNumber = results.documentnumber,
                min = isNaN(parseFloat(results.min)) ? 0 : parseFloat(results.min),
                max = isNaN(parseFloat(results.max)) ? 0 : parseFloat(results.max)

            if (min < 0) 
                min = 0

            if (max < min)
                throw new Error('Max must be greater than Min.')

            if (documentNumber == '' && max < 0.01)
                throw new Error('Max must be a positive amount.')

            let whereClause = '', modalMsg = ''
            if (documentNumber !== '') {
                whereClause = ` AND t.tranid LIKE '%${documentNumber}%'`
                modalMsg = ` with invoice number ${documentNumber}`
            }
            if (max > 0.01) {
                whereClause += ` AND t.foreignTotal <= ${max} AND t.foreignTotal >= ${min}`
                modalMsg += ` between $${min.toFixed(2)} and $${max.toFixed(2)}`
            }
            
            priModalInputs.showNotification(`Finding transactions${modalMsg}...`, 'md')
            priModalInputs.prepSelectTables([{
                id:'query',
                query:`SELECT
                    t.id as id,
                    CONCAT(BUILTIN.DF(t.id), CONCAT(' - ', CONCAT(CONCAT(c.displaysymbol,TO_CHAR(t.foreignTotal,'999,999.99')), CONCAT(' (', CONCAT(BUILTIN.DF(t.entity), ')'))))) as text
                FROM transaction AS t
                JOIN transactionline AS tl
                    ON tl.transaction = t.id
                    AND tl.mainline = 'T'
                JOIN currency AS c
                    ON c.id = t.currency
                JOIN entity AS e
                    ON e.id = t.entity
                WHERE t.recordtype = 'invoice' AND t.billingStatus = 'T' AND tl.subsidiary = ${subsidiary}
                    ${whereClause}
                ORDER BY t.foreignTotal ASC`
            }])

            priModalInputs.waitForSelectTablesLoad(['query'])
                .then(() => {
                    priModalInputs.hideNotification()
                    priModalInputs.showModal({
                        size : 'md',
                        message : 'Select a Transaction',
                        title : 'Find Transactions',
                        fields : [
                            {
                                id : 'select',
                                text : 'Transactions with Similar Amounts',
                                type_text : 'select', // because we're copying to a clipboard, only use select
                                selectfrom_text : 'query',
                                value : ''
                            }
                        ]
                    })
                    .then(results => {
                        console.log('confirm', results);

                        // new callback: write value to clipboard
                        const txt = results.select_text.split('-')[0].trim()
                        if (txt != '') {
                            navigator.clipboard.writeText(txt)
                            .then(
                                (success) => alert('Transaction number copied to clipboard.'),
                                (err) => console.log('Error copying transaction number.')
                            );
                        }
                        window.PERFORM_AUTO_APPLY = false
                    })
                })
        })
        .catch(error => {
            console.log('cancel', error)
            window.PERFORM_AUTO_APPLY = false
            if (error.message)
                alert(`Error: ${error.message}`)
        })
    }

    // Auto-applies the available balance in sequential line order
    function autoApply() {
        const fn = `${scriptName}.autoApply`
        const currentRecord = CurrentRecord.get()
        
        window.PERFORM_AUTO_APPLY = true
        const sublistId = SUBLIST_ID

        let {amountRemaining, currency} = getAmountRemaining(currentRecord)
        logger(`${fn} Start`, {amountRemaining, currency})
        for (line=0; line<currentRecord.getLineCount({sublistId}); ++line) {
            logger(`${fn} Line ${line}`, {amountRemaining, currency})
            try {
                currentRecord.selectLine({sublistId,line})
            } catch (err) {
                continue
            }
            const open = parseFloat(currentRecord.getCurrentSublistValue({sublistId,fieldId:`${sublistId}_open`})),
                payment = currentRecord.getCurrentSublistValue({sublistId,fieldId:`${sublistId}_payment`}),
                amount = currentRecord.getCurrentSublistValue({sublistId,fieldId:`${sublistId}_apply`}),
                transactionCurrency = currentRecord.getCurrentSublistText({sublistId, fieldId:`${sublistId}_currency`})
            if (amountRemaining < 0.01) {
                currentRecord.cancelLine({sublistId})
                break
            }
            if (isNaN(open) || open <= 0 || !!payment || !!amount)
                continue

            if (transactionCurrency !== currency)
                continue

            let apply = open
            if (amountRemaining <= apply)
                apply = amountRemaining
            
            currentRecord.setCurrentSublistValue({
                sublistId,
                fieldId:`${sublistId}_autoapply`,
                value:true,
                forceSyncSourcing:true,
                ignoreFieldChange:true
            })
            currentRecord.setCurrentSublistValue({
                sublistId,
                fieldId:`${sublistId}_apply`,
                value:Number(apply).toFixed(2),
                forceSyncSourcing:true,
                ignoreFieldChange:false
            })
            currentRecord.commitLine({sublistId})
            
            amountRemaining -= apply
        }
        logger(`${fn} End`, amountRemaining)

        window.PERFORM_AUTO_APPLY = false

        updateAmountToApply(currentRecord)
        confirmWriteOffPayments(currentRecord)
    }

    // Redirects the request to the CashApp Apply Transaction Suitelet
    function writeOffOverpayment() {
        const fn = `${scriptName}.autoApply`
        const currentRecord = CurrentRecord.get()
        logger(fn, currentRecord)
        const loc = url.resolveScript({
            scriptId:'customscript_pri_cashapp_apply_sl',
            deploymentId:'customdeploy_pri_cashapp_apply_sl',
            params:{
                cashappid:currentRecord.id,
                writeoff_overpayment:'T'
            }
        })
        window.location.href = loc
    }

    function taboolaVoid() {
        const fn = `${scriptName}.taboolaVoid`
        const currentRecord = CurrentRecord.get()
        logger(fn, currentRecord)
        const loc = url.resolveScript({
            scriptId:'customscript_pri_cashapp_apply_sl',
            deploymentId:'customdeploy_pri_cashapp_apply_sl',
            params:{
                cashappid:currentRecord.id,
                taboola_void:'T'
            }
        })
        window.location.href = loc
    }

    //#endregion
    /* ====================================================================================================== */
    //#region Private methods

    /**
     * Logs a message to both window.console and N/log
     * @param {string} title - The log title
     * @param {string|Object} message - The log message
     * @param {string?} type - The log type
     */
    function logger (title, message, type) {
        if (typeof type !== 'string' || type === '')
            type = 'debug'
        
        switch (type.trim().toLowerCase()) {
        case 'error':
            type = 'error'
            break
        case 'audit':
            type = 'audit'
            break
        case 'emergency':
            type = 'emergency'
            break
        default:
            type = 'debug'
            break
        }
        
        if (type === 'debug' && !!log)
            log[type](title, typeof message === 'object' ? JSON.stringify(message) : message)
        
        const consoleType = type === 'error' ? type : 'log'
        !!console && !!console[consoleType] && console[consoleType](title, message)
    }

    // 
    function initializeFindTransactionsTable(currentRecord) {
        const batch = currentRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_batch'}),
            paymentAmount = currentRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_amount'}),
            writeOff = parseFloat(parseFloat(currentRecord.getValue({fieldId:'custpage_writeoff_threshold'})).toFixed(2))
        const minAmount = paymentAmount - writeOff,
            maxAmount = paymentAmount + writeOff
        window.DEFAULT_MIN_AMOUNT = minAmount
        window.DEFAULT_MAX_AMOUNT = maxAmount
        window.WRITE_OFF_AMOUNT = writeOff
    }

    // Taboola: Source Transaction Data
    function sourceTransactionData(transactionId, currentRecord, sublistId) {
        const fn = `${scriptName}.sourceTransactionData`

        let datePreference = currentRecord.getValue({fieldId:'custpage_date_preference'})
        if (!datePreference) {
            datePreference = 'MM/DD/YYYY'
        }

        let rec = null
        try {
            rec = record.load({type:'invoice', id:transactionId})
        } catch (err) {
            logger(fn, err, 'error')
        }
        if (!rec) debugger

        const tran = currentRecord.getCurrentSublistValue({sublistId, fieldId:`${sublistId}_id`})
        if (!tran)
            currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_id`, value:transactionId})

        currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_customer`, value:rec.getText('entity')})
        currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_customerval`, value:rec.getValue('entity')})

        const isPaidInFull = rec.getValue('statusRef') === 'paidInFull'
        currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_canapply`, value:!isPaidInFull})
        currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_status`, value:rec.getText('status')})

        currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_currency`, value:rec.getValue('currency')})
        try {
            currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_billcountry`, value:rec.getSubrecord('billingaddress').getValue('country')})
        } catch (err) {
            logger(fn, err, 'error')
            debugger
        }
        currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_date`, value:rec.getValue('trandate')})
        currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_subtotal`, value:rec.getValue('subtotal')})
        currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_total`, value:rec.getValue('total')})
        currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_open`, value:rec.getValue('amountremaining')})
        currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_rule`, value:'Manual'})
    }
   
    // Looks up Transaction data and sets the current transaction data on the sublist
    function sourceTransactionData_0(transactionId, currentRecord, sublistId) {
        const fn = `${scriptName}.sourceTransactionData`

        let datePreference = currentRecord.getValue({fieldId:'custpage_date_preference'})
        if (!datePreference) {
            datePreference = 'MM/DD/YYYY'
        }

        let lookup = null
        try {
            lookup = search.lookupFields({
                type:'transaction',
                id:transactionId,
                columns:[
                    'entity',
                    'trandate',
                    'status',
                    'amount',
                    'fxamount',
                    'currency',
                    'exchangerate',
                    'fxamountremaining',
                    'transactionname',
                    'billcountry'
                ]
            })
            logger(fn, lookup)
        } catch (err) {
            try {
                lookup = search.lookupFields({
                    type:'transaction',
                    id:transactionId,
                    columns:[
                        'entity',
                        'trandate',
                        'status',
                        'amount',
                        'fxamount',
                        'exchangerate',
                        'amountremaining',
                        'transactionname',
                        'billcountry'
                    ]
                })
                logger(fn, lookup)
            } catch (err) {
                logger(fn, err, 'error')
            }
        }

        if (!lookup) return

        const tran = currentRecord.getCurrentSublistValue({sublistId, fieldId:`${sublistId}_id`})
        if (!tran) {
            logger(fn, lookup.transactionname)
            // currentRecord.setCurrentSublistText({sublistId, fieldId:`${sublistId}_id`, text:lookup.transactionname,forceSyncSourcing:true})
            currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_id`, value:transactionId})
        }

        if (lookup.entity && lookup.entity.length > 0 && lookup.entity[0].value !== '') {
            currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_customer`, value:lookup.entity[0].text})
            currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_customerval`, value:lookup.entity[0].value})
        }

        if (lookup.status && lookup.status.length > 0) {
            const isPaidInFull = lookup.status[0].value === 'paidInFull'
            currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_canapply`, value:!isPaidInFull})
            currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_status`, value:lookup.status[0].text})
        }

        if (lookup.currency && lookup.currency.length > 0) {
            currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_currency`, value:lookup.currency[0].value})
        } else {
            currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_currency`, value:'1'})
        }

        if (!!lookup.billcountry && lookup.billcountry.length > 0) {
            currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_billcountry`, value:lookup.billcountry[0].value})
        }

        currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_date`, value:formatDate({[datePreference]:lookup.trandate})})
        currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_total`, value:lookup.fxamount})
        if (lookup.fxamountremaining) {
            currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_open`, value:lookup.fxamountremaining})
        } else if (lookup.amountremaining) {
            currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_open`, value:lookup.amountremaining})
        }
        currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_rule`, value:'Manual'})

    }

    // a callback for the Auto-Apply checkbox field to automatically set an Apply amount on the line
    function autoApplyCurrentLine(currentRecord) {
        const fn = `${scriptName}.autoApplyCurrentLine`
        logger(fn, currentRecord)

        const sublistId = SUBLIST_ID,
            autoApply = currentRecord.getCurrentSublistValue({sublistId, fieldId:`${sublistId}_autoapply`}),
            balance = currentRecord.getCurrentSublistValue({sublistId, fieldId:`${sublistId}_open`}),
            payment = currentRecord.getCurrentSublistValue({sublistId,fieldId:`${sublistId}_payment`}),
            billcountry = currentRecord.getCurrentSublistValue({sublistId,fieldId:`${sublistId}_billcountry`}),
            subtotal = currentRecord.getCurrentSublistValue({sublistId,fieldId:`${sublistId}_subtotal`}),
            total = currentRecord.getCurrentSublistValue({sublistId,fieldId:`${sublistId}_total`}),
            transactionCurrency = currentRecord.getCurrentSublistText({sublistId, fieldId:`${sublistId}_currency`}),
            {amountRemaining, currency} = getAmountRemaining(currentRecord, currentRecord.getCurrentSublistIndex({sublistId}), 0)

        if (payment !== '') return

        if (autoApply === 'F' || !autoApply) {

            window.PERFORM_AUTO_APPLY = true

            currentRecord.setCurrentSublistValue({
                sublistId,
                fieldId:`${sublistId}_apply`,
                value:'',
                forceSyncSourcing:true,
                ignoreFieldChange:false
            })

            window.PERFORM_AUTO_APPLY = false
        } else {
            // Do nothing if there is an applied payment
            if (amountRemaining < 0.01) return
            if (isNaN(parseFloat(balance)) || parseFloat(balance) <= 0)
                return

            window.PERFORM_AUTO_APPLY = true

            let apply = balance
            if (amountRemaining <= apply)
                apply = amountRemaining

            // Taboola WHT
            const tblaWhtMarkup = taboolaWhtMarkupAmount(currentRecord, apply)
            if (tblaWhtMarkup > 0) {
                currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_tbla_wht`, 
                    value:JSON.stringify({whtMarkup:tblaWhtMarkup})})
                if ((apply + tblaWhtMarkup) <= amountRemaining) {
                    apply += tblaWhtMarkup
                }
            }

            currentRecord.setCurrentSublistValue({
                sublistId,
                fieldId:`${sublistId}_apply`,
                value:Number(apply).toFixed(2),
                forceSyncSourcing:true,
                ignoreFieldChange:false
            })

            window.PERFORM_AUTO_APPLY = false
        }
    }

    function updateForeignAmount(currentRecord) {
        const fn = `${scriptName}.updateForeignAmount`
        const foreignCurrency = currentRecord.getValue({fieldId: 'custrecord_pri_cashapp_trans_foreigncur'})
        if (!foreignCurrency) return

        const sublistId = SUBLIST_ID
        let totalApply = 0
        for (let line = 0; line < currentRecord.getLineCount({sublistId}); ++line) {
            const apply = parseFloat(currentRecord.getSublistValue({sublistId, line, fieldId: `${sublistId}_apply`}))
            if (!isNaN(apply) && apply > 0)
                totalApply += apply
        }
        totalApply = Math.round(totalApply * 100) / 100
        logger(fn, {foreignCurrency, totalApply})

        currentRecord.setValue({
            fieldId: 'custrecord_pri_cashapp_trans_foreignamt',
            value: totalApply > 0 ? totalApply : '',
            ignoreFieldChange: false
        })
    }

    function updateAmountToApply(currentRecord) {
        const fn = `${scriptName}.updateAmountToApply`
        if (!window.PERFORM_AUTO_APPLY) {
            let {amountRemaining:remaining, currency} = getAmountRemaining(currentRecord)
            if (remaining<0)
                remaining = 0
            currentRecord.setValue({fieldId:'custpage_amount_remaining',value:`${remaining.toFixed(2)} (${currency})`})
        }
    }

    // Iterates through the custom UI sublist to determine the amount remaining to be applied to new payments
    function getAmountRemaining(currentRecord, currentLine, currentAmount) {
        const fn = `${scriptName}.getAmountRemaining`

        const dummyPymtId = currentRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_dummypymt'}),
            bankFee = currentRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_bankfee'}),
            sublistId = SUBLIST_ID

        let {amountUnapplied:amountRemaining, currency} = getAmountUnapplied(currentRecord, dummyPymtId)
        for (line=0; line<currentRecord.getLineCount({sublistId}); ++line) {
            const id = currentRecord.getSublistValue({sublistId,line,fieldId:`${sublistId}_id`}),
                open = !isNaN(parseFloat(currentRecord.getSublistValue({sublistId,line,fieldId:`${sublistId}_open`})))
                    ? parseFloat(currentRecord.getSublistValue({sublistId,line,fieldId:`${sublistId}_open`})) : 0,
                payment = currentRecord.getSublistValue({sublistId,line,fieldId:`${sublistId}_payment`})
            if (!!payment || open == 0) continue
            const currency = currentRecord.getSublistText({sublistId,line,fieldId:`${sublistId}_currency`})
            logger(fn, {line, currency})
            let apply = !isNaN(parseFloat(currentRecord.getSublistValue({sublistId,line,fieldId:`${sublistId}_apply`})))
                ? parseFloat(currentRecord.getSublistValue({sublistId,line,fieldId:`${sublistId}_apply`})) : 0
            if (line === currentLine && currentAmount <= apply) {
                apply = currentAmount
            }
            if (apply > 0)
                amountRemaining -= apply
        }
        amountRemaining = Math.round(amountRemaining*100)/100
        logger(fn, {amountRemaining})
        return {amountRemaining, currency}
    }

    // Returns the amount to apply field
    function getAmountUnapplied(currentRecord, dummyPymtId) {
        const fn = `${scriptName}.getAmountUnapplied`
        const bankFee = currentRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_bankfee'})
        let currency = currentRecord.getValue({fieldId:'custpage_default_currency'})
        if (!currency) {
            currency = '1'
        }
        let amountUnapplied = parseFloat(currentRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_amount'}))
        if (!window.DUMMY_PAYMENT_AMOUNT) {
            dummyPymtId = !!dummyPymtId && !isNaN(parseInt(dummyPymtId)) && parseInt(dummyPymtId) || -1
            if (dummyPymtId < 0) return {amountUnapplied:0, currency}
            const lookup = search.lookupFields({type:'customerpayment',id:dummyPymtId,columns:['fxamount']})
            window.DUMMY_PAYMENT_AMOUNT = !!lookup.fxamount && !isNaN(parseFloat(lookup.fxamount)) 
                && parseFloat(lookup.fxamount) || 0
        }
        // const exchangeRate = currentRecord.getValue({fieldId:'custpage_currency_exchange_rate'})
        // Taboola Cash App Transaction - Editable Exchange Rate
        const taboolaFxBalanceThreshold = 0.1
        const foreignAmount = currentRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_foreignamt'})
        const exchangeRate = currentRecord.getValue({fieldId:'custrecord_pri_cashapp_trans_exchrate'})
        let dummyPaymentAmount = window.DUMMY_PAYMENT_AMOUNT
        if (exchangeRate) {
            dummyPaymentAmount = Math.round((window.DUMMY_PAYMENT_AMOUNT / exchangeRate) * 100) / 100
            currency = currentRecord.getText({fieldId:'custrecord_pri_cashapp_trans_foreigncur'})
        }
        if (!isNaN(dummyPaymentAmount)) {
            amountUnapplied = dummyPaymentAmount
        }
        if (!!exchangeRate && exchangeRate !== 1 && !!foreignAmount) {
            amountUnapplied = foreignAmount
        }
        logger(fn, {amountUnapplied})
        return {amountUnapplied, currency}
    }

    // Validates the current amount being applied
    function validateApplyAmount(currentRecord, sublistId) {
        const fn = `${scriptName}.validateApplyAmount`

        if (window.PERFORM_AUTO_APPLY) return true

        logger(fn)
        const index = currentRecord.getCurrentSublistIndex({sublistId}),
            id = currentRecord.getCurrentSublistValue({sublistId, fieldId:`${sublistId}_id`}),
            payment = currentRecord.getCurrentSublistValue({sublistId, fieldId:`${sublistId}_payment`}),
            open = currentRecord.getCurrentSublistValue({sublistId, fieldId:`${sublistId}_open`}),
            apply = currentRecord.getCurrentSublistValue({sublistId, fieldId:`${sublistId}_apply`}),
            transactionCurrency = currentRecord.getCurrentSublistText({sublistId, fieldId:`${sublistId}_currency`}),
            {amountRemaining:remainingBefore} = getAmountRemaining(currentRecord),
            {amountRemaining:remaining, currency} = getAmountRemaining(currentRecord, index, apply)

        // logger(fn, {remainingBefore, remaining, currency})

        if (!!payment) {
            alert('Cannot change the balance of a paid transaction from this page.')
            return false
        }
        if (!id) return false // do not allow a payment for a row without an invoice
        if (apply == '') return true // always allow empty amounts

        if (apply === 0) {
            currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_apply`, value:'', ignoreFieldChange:true})
            return true
        }

        // if (transactionCurrency !== currency) {
        //     alert(`Cannot apply an amount in ${transactionCurrency} to a transaction in ${currency}.`)
        //     return false
        // }

        if (apply < 0) {
            alert('Cannot apply an amount less than $0.')
            return false
        }

        if (remaining<0) {
            alert(`Cannot apply an amount that is greater than the remaining amount.`)
            currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_apply`, value:Number(remainingBefore).toFixed(2)})
            return false
        }

        const tbWhtMarkup = taboolaWhtMarkupAmount(currentRecord, apply)
        if (tbWhtMarkup > 0) {
            currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_tbla_wht`, value:JSON.stringify({whtMarkup:tbWhtMarkup})})
            if ((apply + tbWhtMarkup) <= remaining) {
                currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_apply`, value:Number(apply + tbWhtMarkup).toFixed(2)})
            }
            return true
        }
        else if (apply > open) {
            alert(`Cannot apply an amount that is greater than the open balance ($${open}).`)
            currentRecord.setCurrentSublistValue({sublistId, fieldId:`${sublistId}_apply`, value:Number(open).toFixed(2)})
            return false
        }

        return true
    }

    /**
     * Validates the submission of the form and prompts the user to confirm if any deltas below the 
     * write-off threshold should be written off when the payment(s) are created.
     * @returns {boolean} - True to submit record
     */
    function confirmWriteOffPayments(currentRecord) {
        const fn = `${scriptName}.confirmWriteOffPayments`
        if (window.PERFORM_AUTO_APPLY) return

        const sublistId = SUBLIST_ID
        let line = currentRecord.getCurrentSublistIndex({sublistId}),
            lineCount = currentRecord.getLineCount({sublistId})

        if (line >= lineCount && lineCount > 0)
            currentRecord.selectLine({sublistId,line:lineCount-1})
        else if (lineCount === 0)
            currentRecord.selectLine({sublistId,line:0})
        
        const clInvoiceName = currentRecord.getCurrentSublistText({sublistId, fieldId:`${sublistId}_id`}),
            clInvoice = currentRecord.getCurrentSublistValue({sublistId, fieldId:`${sublistId}_id`}),
            clCustomer = currentRecord.getCurrentSublistValue({sublistId, fieldId:`${sublistId}_customerval`}),
            clPayment = currentRecord.getCurrentSublistValue({sublistId, fieldId:`${sublistId}_payment`}),
            clOpen = currentRecord.getCurrentSublistValue({sublistId, fieldId:`${sublistId}_open`}),
            clApply = currentRecord.getCurrentSublistValue({sublistId, fieldId:`${sublistId}_apply`}),
            writeOffAmt = !!currentRecord.getValue({fieldId:'custpage_writeoff_threshold'})
                ? parseFloat(currentRecord.getValue({fieldId:'custpage_writeoff_threshold'})) : 0,
            {amountRemaining:remaining, currency} = getAmountRemaining(currentRecord)

        const canWriteOffUnderpayment = remaining <= 0 && !clPayment && clApply < clOpen && (clApply+writeOffAmt) >= clOpen,
            canWriteOffOverpayment = remaining > 0 && remaining <= writeOffAmt && clApply !== '' && clApply == clOpen
        logger(fn, {canWriteOffUnderpayment, canWriteOffOverpayment, remaining, clPayment, clApply, clOpen, writeOffAmt})
        // debugger

        if (canWriteOffUnderpayment) {
            const woAmt = (clOpen-clApply).toFixed(2)
            uiDialog
                .create({
                    title:'Write Off Underpayment',
                    message:`Do you want to write off <b>$${woAmt}</b> from <b>${clInvoiceName}</b>? This will result in ${clInvoiceName} being paid in full.`,
                    buttons:[{label:'Write Off',value:true},/*{label:'Write Off as Bank Fee',value:'B'},*/{label:'Do Not Write Off',value:false}]
                })
                .then(result => {
                    if (result !== false && !!clInvoice)
                        currentRecord.setValue({fieldId:'custpage_writeoff', value:JSON.stringify({
                            amt:parseFloat(woAmt),
                            typ: result === 'B' ? 'B' : 'U',
                            inv: clInvoice !== '' && parseInt(clInvoice) || null,
                            cust: clCustomer !== '' && parseInt(clCustomer) || null,
                        })})
                    currentRecord.selectNewLine({sublistId})
                })
                .catch(err => logger(err.name, err.message, 'error'))
        } else if (canWriteOffOverpayment) {

            // 20260109 Jeff Dennis PTM28085 - Removed write off overpayment button as overpayment functionality not used.
            return
            
            let message = `Do you want to write off the remaining overpayment amount of <b>$${remaining.toFixed(2)}</b>?`
            if (!!clInvoiceName)
                message += ` This will apply to ${clInvoiceName}.`
            uiDialog
                .create({
                    title:'Write Off Overpayment',
                    message,
                    buttons:[{label:'Write Off',value:true},{label:'Do Not Write Off',value:false}]
                })
                .then(result => {
                    if (result && !!clInvoice)
                        currentRecord.setValue({fieldId:'custpage_writeoff', value:JSON.stringify({
                            amt:remaining,
                            typ:'O',
                            inv: clInvoice !== '' && parseInt(clInvoice) || null,
                            cust: clCustomer !== '' && parseInt(clCustomer) || null,
                        })})
                    currentRecord.selectNewLine({sublistId})
                })
                .catch(err => logger(err.name, err.message, 'error'))
        }
    }

    function formatDate(options) {
        const fn = `${scriptName}.formatDate`
        const date = new Date('1/1/1900')
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
            const delim = String(opt).includes('/') ? '/' : '-'
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

    function formatDate_0(options) {
        const fn = `${scriptName}.formatDate`
        log.debug(fn, {options})
        const date = new Date()
        if (options.yymmdd) {
            date.setFullYear(`20${options.yymmdd.substring(0,2)}`)
            date.setDate(options.yymmdd.substring(4))
            date.setMonth(parseInt(options.yymmdd.substring(2,4))-1)
            date.setHours(0)
            date.setMinutes(0)
            date.setSeconds(0)
            date.setMilliseconds(0)
        } else if (options.yyyymmdd) {
            date.setFullYear(options.yyyymmdd.substring(0,4))
            date.setDate(options.yyyymmdd.substring(6))
            date.setMonth(parseInt(options.yyyymmdd.substring(4,6))-1)
            date.setHours(0)
            date.setMinutes(0)
            date.setSeconds(0)
            date.setMilliseconds(0)
        } else if (options.mmddyyyy) {
            date.setFullYear(options.mmddyyyy.split('/')[2])
            date.setDate(options.mmddyyyy.split('/')[1])
            date.setMonth(parseInt(options.mmddyyyy.split('/')[0])-1)
            date.setHours(0)
            date.setMinutes(0)
            date.setSeconds(0)
            date.setMilliseconds(0)
        } else if (options.ddmmyy) {
            date.setFullYear(`20${options.ddmmyy.substring(4)}`)
            date.setDate(options.ddmmyy.substring(0,2))
            date.setMonth(parseInt(options.ddmmyy.substring(2,4))-1)
            date.setHours(0)
            date.setMinutes(0)
            date.setSeconds(0)
            date.setMilliseconds(0)
        } else if (options.mmddyy) {
            date.setFullYear(`20${options.mmddyy.substring(4)}`)
            date.setDate(options.mmddyy.substring(2,4))
            date.setMonth(parseInt(options.mmddyy.substring(0,2))-1)
            date.setHours(0)
            date.setMinutes(0)
            date.setSeconds(0)
            date.setMilliseconds(0)
        } else if (options["D/M/YYYY"]) {
            date.setFullYear(options["D/M/YYYY"].split('/')[2])
            date.setDate(options["D/M/YYYY"].split('/')[0])
            date.setMonth(parseInt(options["D/M/YYYY"].split('/')[1])-1)
            date.setHours(0)
            date.setMinutes(0)
            date.setSeconds(0)
            date.setMilliseconds(0)
        }
        return date
    }

    function taboolaWhtMarkupAmount(currentRecord, amount) {
        const sublistId = SUBLIST_ID,
            billcountry = currentRecord.getCurrentSublistValue({sublistId,fieldId:`${sublistId}_billcountry`}),
            subtotal = currentRecord.getCurrentSublistValue({sublistId,fieldId:`${sublistId}_subtotal`}),
            total = currentRecord.getCurrentSublistValue({sublistId,fieldId:`${sublistId}_total`})
        // Taboola WHT
        if (billcountry === 'TH') {
            const whtRate = currentRecord.getValue({fieldId:'custrecord_tb_wht_rate'})
            // Markup the apply amount by the calculated WHT amount
            const whtTax = (subtotal * (whtRate / 100))
            return amount * (whtTax / (total - whtTax))
        }
        return 0
    }

    function updateWriteoffData(currentRecord, data, replaceAll = false) {
        const fn = `${scriptName}.updateWriteoffData`
        let oldData = currentRecord.getValue({fieldId:'custpage_writeoff'})
        try {
            oldData = JSON.parse(oldData)
        } catch(e) {
            log.error(fn, `Failed to parse old writeoff data. ${e.message}. ${e.stack}`)
            oldData = {}
        }
        if (replaceAll) {
            oldData = data
        } else {
            oldData = { ...oldData, ...data }
        }
        currentRecord.setValue({fieldId:'custpage_writeoff', value:JSON.stringify(oldData)})
    }

    //#endregion
    /* ====================================================================================================== */

    return {
        // standard client functions
        pageInit,
        fieldChanged,
        validateField,
        validateLine,
        validateDelete,
        sublistChanged,

        // custom functions
        autoApply,
        clearAmounts,
        clearResults,
        findTransactions,
        moveBalanceToCustomer,
        moveBalanceToCustomerDeposit,
        writeOffOverpayment,
        taboolaVoid
    }
})