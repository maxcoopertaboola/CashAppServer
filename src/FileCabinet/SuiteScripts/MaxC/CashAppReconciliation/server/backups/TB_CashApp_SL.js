//-----------------------------------------------------------------------------------------------------------
// Copyright 2026, All rights reserved, Prolecto Resources, Inc.
//
// No part of this file may be copied or used without express, written permission of Prolecto Resources, Inc.
//-----------------------------------------------------------------------------------------------------------
//-----------------------------------------------------------------------------------------------------------
// Description: Suitelet that supports Cash Application. 
//-----------------------------------------------------------------------------------------------------------
// Version History
// 2026-03-17   Jeff Dennis   PTM28554: Initial version created
//
//-----------------------------------------------------------------------------------------------------------

/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define([
    'N/log',
    'N/record',
], function(log, record) {
    const scriptName = 'TB_CashApp_SL'

    /* ====================================================================================================== */
    //#region Script Endpoints

    /**
     * Main entry point. Handles suitelet HTTP request and response
     * @param {Object} context - Suitelet Context
     */
    function onRequest(context) {
        const fn = `${scriptName}.render`,
            { request, response } = context,
            { method, parameters, header, body, files } = request
        
        if (!parameters.action)
            throw new Error('Action is required')

        switch (parameters.action) {
        case 'blind-save-th-payment': {
            if (!parameters.paymentId)
                throw new Error('Payment ID is required')

            const maxRetries = 3
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const payment = record.load({type:'customerpayment', id:parameters.paymentId})
                    payment.setValue({fieldId:'customform', value:155}) // Intentionaly Hard-coded Custom Form for WHT
                    payment.save({ignoreMandatoryFields:true})
                    log.debug(fn, `Blind-save succeeded on attempt ${attempt} for payment ${parameters.paymentId}`)
                    break
                } catch (e) {
                    if (e.name === 'CUSTOM_RECORD_COLLISION' && attempt < maxRetries) {
                        log.audit(fn, `Record collision on attempt ${attempt} for payment ${parameters.paymentId}, retrying...`)
                    } else {
                        throw e
                    }
                }
            }
            break
        }
        default:
            throw new Error(`Invalid action: ${parameters.action}`)
        }
    }
    
    //#endregion Script Endpoints
    /* ====================================================================================================== */
    //#region Private methods

    //#endregion
    /* ====================================================================================================== */

    return { onRequest }
})
