//-----------------------------------------------------------------------------------------------------------
// Copyright 2024, All rights reserved, Prolecto Resources, Inc.
//
// No part of this file may be copied or used without express, written permission of Prolecto Resources, Inc.
//-----------------------------------------------------------------------------------------------------------
//-----------------------------------------------------------------------------------------------------------
// Description: User Event script that is intended to be deployed to every type of native or custom
//             transaction used by the Cash Application. This script synchronizes changes to native payments.
//-----------------------------------------------------------------------------------------------------------
// Version History
// 20240328 Jeff Dennis PTM20064
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
    './PRI_CashApp_Common',
], function(log, runtime, cashApp) {
    const scriptName = 'PRI_CashApp_UE_CustomerPayment'

    function beforeSubmit(context) {
        const fn = `${scriptName}.beforeSubmit`
        const { UserEventType, type, newRecord, oldRecord } = context,
            { ContextType, executionContext } = runtime

        log.debug(fn, {exchangeRate:newRecord.getValue({fieldId:'exchangerate'})})
    }

    /**
     * Runs after the record is submitted to the database
     * @param {Object} context - User Event Context
     */
    function afterSubmit(context) {
        const fn = `${scriptName}.afterSubmit`
        const { UserEventType, type, newRecord, oldRecord } = context,
            { ContextType, executionContext } = runtime

        log.debug(fn, {exchangeRate:newRecord.getValue({fieldId:'exchangerate'})})

        // Note: this line is added to allow Map/Reduce record scripts to process without downstream events being triggered
        // May want to add additional condition here so that we are only ignoring PRI CashApp scripts (perhaps a custom role?)
        if (executionContext === ContextType.MAP_REDUCE)
            return

        // We're observing everything but edit and delete events in afterSubmit
        if (type !== UserEventType.EDIT && type !== UserEventType.XEDIT && type !== UserEventType.DELETE)
            return

        const isVoidEvent = (type === UserEventType.EDIT && !!newRecord.getValue({fieldId:'void'}) 
            && executionContext === ContextType.USER_INTERFACE)
        log.debug(fn, JSON.stringify({isVoidEvent}))

        // This script only cares about native transactions that are linked to a PRI CashApp Transaction
        let paymentId = newRecord.id,
            cashAppTransaction = newRecord.getValue({fieldId:'custbody_pri_cashapp_transaction'}),
            writeOffType = newRecord.getValue({fieldId:'custbody_pri_cashapp_writeofftype'})
        if (type === UserEventType.DELETE || isVoidEvent) {
            paymentId = oldRecord.id
            cashAppTransaction = oldRecord.getValue({fieldId:'custbody_pri_cashapp_transaction'})
            writeOffType = oldRecord.getValue({fieldId:'custbody_pri_cashapp_writeofftype'})
        }
        if (!cashAppTransaction) return

        // Write-off transactions (Journal Entries created by applyCashAppTransaction with
        // custbody_pri_cashapp_writeofftype set, e.g. 'bankfeeunderpayment', 'overpayment',
        // 'underpayment') are managed by the apply flow itself. Letting syncPaymentChange
        // run against them races with applyCashAppTransaction and can flip the cash-app
        // transaction's matchstatus back to APPLIED_PARTIAL after the write-off JE is created.
        if (!!writeOffType) {
            log.debug(fn, `Skipping syncPaymentChange for write-off transaction ${paymentId} (writeofftype=${writeOffType}).`)
            return
        }

        // Sync the delete event back to CashApp
        cashApp.syncPaymentChange(paymentId, cashAppTransaction, type, executionContext, isVoidEvent)
    }

    return { beforeSubmit, afterSubmit }
})
