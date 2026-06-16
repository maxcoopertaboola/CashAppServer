/**
 * TB_CashApp_StatsRefresh_MR.js
 *
 * Refreshes the customrecord_tb_cashapp_stats custom record table by:
 *   1. Deleting all existing stat records.
 *   2. Running the analyzingStats SuiteQL query.
 *   3. Creating one new stat record per result row.
 *
 * Deployment parameters:
 *   custscript_tb_cashapp_stat_subsidiaries  {string}  Comma-separated subsidiary IDs  (e.g. '14,26,24')
 *   custscript_tb_cashapp_stat_from_date     {string}  Lower-bound trans_date           (e.g. '01/11/2025')
 *
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 */
define(['N/query', 'N/record', 'N/search', 'N/runtime', 'N/log', './config/queryBuilder'],
    function (query, record, search, runtime, log, queryBuilder) {

    // ─── getInputData ───────────────────────────────────────────────────────────
    /**
     * Deletes all existing stat records, then runs the analyzingStats query and
     * returns each result row as an individual input item for the map stage.
     * @returns {Array<Object>}
     */
    function getInputData() {
        var script       = runtime.getCurrentScript();
        var subsidiaries = script.getParameter({ name: 'custscript_tb_cashapp_stat_subsidiaries' });
        var fromDate     = script.getParameter({ name: 'custscript_tb_cashapp_stat_from_date' });

        log.audit({
            title:   'StatsRefresh | getInputData | Start',
            details: 'subsidiaries=' + subsidiaries + '  fromDate=' + fromDate
        });

        _deleteExistingStats();

        var built = queryBuilder.buildAnalyzingStats(subsidiaries, fromDate);

        log.debug({
            title:   'StatsRefresh | getInputData | Query',
            details: built.query
        });
        log.debug({
            title:   'StatsRefresh | getInputData | Params',
            details: JSON.stringify(built.params)
        });

        var results;
        try {
            results = query.runSuiteQL({ query: built.query, params: built.params });
        } catch (e) {
            log.error({
                title:   'StatsRefresh | getInputData | Query execution failed',
                details: 'Message: ' + e.message + '  |  Name: ' + e.name + '  |  Query: ' + built.query + '  |  Params: ' + JSON.stringify(built.params)
            });
            throw e;
        }

        var rows = results.asMappedResults();

        log.audit({
            title:   'StatsRefresh | getInputData | Query complete',
            details: rows.length + ' stat rows returned'
        });

        return rows;
    }

    // ─── map ────────────────────────────────────────────────────────────────────
    /**
     * Creates one customrecord_tb_cashapp_stats record per stat row.
     * @param {MapReduceContext.MapContext} context
     */
    function map(context) {
        var row = JSON.parse(context.value);

        var statRecord = record.create({ type: 'customrecord_tb_cashapp_stats' });
        statRecord.setValue({ fieldId: 'custrecord_tb_cashapp_stat_subsidiary', value: row.subsidiary    });
        statRecord.setValue({ fieldId: 'custrecord_tb_cashapp_stat_account',    value: row.bank_account  });
        statRecord.setValue({ fieldId: 'custrecord_tb_cashapp_stat_status',     value: row.status        });
        statRecord.setValue({ fieldId: 'custrecord_tb_cashapp_stat_count',      value: row.result_count  });
        var newId = statRecord.save();

        log.debug({
            title:   'StatsRefresh | map | Record created',
            details: 'id=' + newId + '  subsidiary=' + row.subsidiary + '  account=' + row.bank_account + '  status=' + row.status + '  count=' + row.result_count
        });

        context.write({ key: String(newId), value: '1' });
    }

    // ─── summarize ──────────────────────────────────────────────────────────────
    /**
     * Logs per-stage errors and the final creation count.
     * @param {MapReduceContext.SummarizeContext} summary
     */
    function summarize(summary) {
        var totalCreated = 0;
        summary.output.iterator().each(function (key) {
            totalCreated++;
            return true;
        });

        // Log any map-stage errors
        var mapErrors = 0;
        summary.mapSummary.errors.iterator().each(function (key, error) {
            mapErrors++;
            log.error({
                title:   'StatsRefresh | map | Error for key: ' + key,
                details: error
            });
            return true;
        });

        log.audit({
            title:   'StatsRefresh | summarize | Complete',
            details: [
                'Created: '     + totalCreated,
                'Map errors: '  + mapErrors,
                'Governance: '  + summary.usage,
                'Concurrency: ' + summary.concurrency,
                'Yields: '      + summary.yields
            ].join('  |  ')
        });
    }

    // ─── private helpers ────────────────────────────────────────────────────────

    /**
     * Searches for all existing customrecord_tb_cashapp_stats records and deletes them.
     */
    function _deleteExistingStats() {
        var deletedCount = 0;

        search.create({
            type:    'customrecord_tb_cashapp_stats',
            filters: [],
            columns: [search.createColumn({ name: 'internalid' })]
        }).run().each(function (result) {
            record.delete({ type: 'customrecord_tb_cashapp_stats', id: result.id });
            deletedCount++;
            return true;
        });

        log.audit({
            title:   'StatsRefresh | getInputData | Existing records deleted',
            details: deletedCount + ' records removed'
        });
    }

    return {
        getInputData: getInputData,
        map:          map,
        summarize:    summarize
    };
});
