/**
 * Utils/matching.js
 * Finds the best invoice or combination of invoices whose unpaid balances
 * (or WHT-adjusted apply amounts) sum to the cash app transaction amount.
 *
 * WHT-aware matching layer
 * ────────────────────────
 * Some withholding-tax regimes reduce the amount the customer actually
 * wires by `subtotal × WHT rate` per invoice.  In that case the
 * combination search uses the apply amount
 *
 *     apply = invoice_unpaid_balance - invoice_subtotal × wht_rate
 *
 * instead of the raw unpaid balance, the matching tolerance is widened
 * to 1 currency unit, and any residual is absorbed into the matched
 * invoice with the highest invoice_id (i.e. the LAST line in the
 * user-visible id-sorted display) so the combination sums exactly to
 * the transaction amount.
 *
 * Currently only the "India" regime activates this layer.  Every other
 * regime — including "" / null / unknown labels — falls through to the
 * legacy unpaid-balance summation.  To enable additional regimes, add a
 * lowercase label to WHT_REGIMES.
 */

define(['N/log'], function(log) {

    var MAX_INVOICES_TO_EVALUATE = 25;
    var DEFAULT_TOLERANCE_CENTS = 1;     // ±0.01 currency unit (legacy path)
    var WHT_TOLERANCE_CENTS = 100;        // ±1.00 currency unit (per spec)

    // The set of regime labels (lowercase) for which the WHT-aware layer
    // engages.  Match is exact (case-insensitive).  Add new regimes here.
    var WHT_REGIMES = {
        india: true
    };

    /**
     * For each transaction, finds the smallest set of invoices whose
     * apply amounts sum to cash_app_transaction_amount and marks them
     * with `suggested = true` and a numeric `apply_amount`.
     *
     * @param {Array<Object>} transactions - Output of transformInvoices
     * @returns {Array<Object>} - Same array with suggested flags applied
     */
    function matchInvoicesToTransactions(transactions) {
        if (!transactions || !transactions.length) return transactions;

        transactions.forEach(function(transaction) {
            var invoices = transaction.invoices;
            if (!invoices || invoices.length === 0) return;

            var target = transaction.cash_app_transaction_amount;
            if (!target || target <= 0) return;

            var whtContext = resolveWhtContext(transaction);
            var matchedIndices = findBestMatch(invoices, target, whtContext);
            if (matchedIndices.length === 0) return;

            stampApplyAmounts(invoices, matchedIndices, target, whtContext);

            transaction.cash_app_transaction_match_status = 'Exact Match';

            transaction.invoices = invoices.slice().sort(function(a, b) {
                return (a.invoice_id || 0) - (b.invoice_id || 0);
            });
        });

        return transactions;
    }

    /**
     * Returns { regime, rate } when the transaction has a supported
     * regime AND a positive WHT rate, otherwise null (legacy path).
     *
     * Regime is sourced from `cash_app_transaction_wht_regime`, which
     * in the SuiteQL view comes from BUILTIN.DF and is therefore the
     * display label (e.g. "India").  When the field arrives as
     * `{ value, text }` (lookupFields style) the text is used.
     */
    function resolveWhtContext(transaction) {
        var regimeRaw = transaction.cash_app_transaction_wht_regime;
        var regimeKey = null;

        if (typeof regimeRaw === 'string') {
            regimeKey = regimeRaw.trim().toLowerCase();
        } else if (regimeRaw && typeof regimeRaw === 'object' && regimeRaw.text) {
            regimeKey = String(regimeRaw.text).trim().toLowerCase();
        }

        if (!regimeKey || !WHT_REGIMES[regimeKey]) return null;

        var rate = parseFloat(transaction.cash_app_transaction_wht_rate);
        if (isNaN(rate) || rate <= 0) return null;

        return { regime: regimeKey, rate: rate };
    }

    /**
     * Computes the apply amount (in integer cents) for a single invoice
     * under the given WHT context.  Falls back to the raw unpaid balance
     * when no context is supplied or when the invoice has no usable
     * subtotal (e.g. journals where invoice_subtotal is null).
     */
    function applyCentsFor(invoice, whtContext) {
        var unpaid = parseFloat(invoice.invoice_unpaid_balance) || 0;
        var unpaidCents = Math.round(unpaid * 100);

        if (!whtContext) return unpaidCents;

        var subtotal = parseFloat(invoice.invoice_subtotal);
        if (isNaN(subtotal) || subtotal <= 0) return unpaidCents;

        return Math.round((unpaid - subtotal * whtContext.rate) * 100);
    }

    /**
     * Finds the smallest subset of invoices whose apply amounts sum to
     * the target amount within tolerance.  Works in integer cents to
     * avoid floating-point drift.  Invoices are sorted ascending so the
     * search can prune branches early when remaining amounts are
     * exceeded.
     *
     * @param {Array<Object>} invoices
     * @param {number} targetAmount
     * @param {Object|null} whtContext - { regime, rate } or null
     * @returns {Array<number>} - originalIndex of each matched invoice,
     *                            sorted ascending; empty array on no match
     */
    function findBestMatch(invoices, targetAmount, whtContext) {
        var targetCents = Math.round(targetAmount * 100);
        var n = Math.min(invoices.length, MAX_INVOICES_TO_EVALUATE);
        var tolerance = whtContext ? WHT_TOLERANCE_CENTS : DEFAULT_TOLERANCE_CENTS;

        var indexed = [];
        for (var i = 0; i < n; i++) {
            indexed.push({
                originalIndex: i,
                cents: applyCentsFor(invoices[i], whtContext)
            });
        }

        indexed.sort(function(a, b) { return a.cents - b.cents; });

        for (var size = 1; size <= n; size++) {
            var combo = findCombination(indexed, targetCents, 0, size, [], tolerance);
            if (combo) {
                return combo
                    .map(function(c) { return c.originalIndex; })
                    .sort(function(a, b) { return a - b; });
            }
        }

        return [];
    }

    /**
     * Recursive backtracking search for exactly `remaining` size invoices
     * whose cent values sum to `targetCents` within `tolerance`.
     *
     * Because `indexed` is sorted ascending, as soon as an invoice's value
     * exceeds the remaining target (plus tolerance) we can break out of
     * the loop — every subsequent invoice is at least as large.
     */
    function findCombination(indexed, targetCents, startIdx, remaining, current, tolerance) {
        if (remaining === 0) {
            return Math.abs(targetCents) <= tolerance ? current.slice() : null;
        }

        var needed = indexed.length - startIdx;
        if (needed < remaining) return null;

        for (var i = startIdx; i <= indexed.length - remaining; i++) {
            if (indexed[i].cents > targetCents + tolerance) break;

            current.push(indexed[i]);
            var result = findCombination(
                indexed,
                targetCents - indexed[i].cents,
                i + 1,
                remaining - 1,
                current,
                tolerance
            );
            if (result) return result;
            current.pop();
        }

        return null;
    }

    /**
     * Marks each matched invoice with `suggested = true` and a numeric
     * `apply_amount`.
     *
     * Without WHT: apply_amount = invoice_unpaid_balance.
     *
     * With WHT (India today): every matched invoice except the rounder
     * gets its WHT-net amount (`unpaid − subtotal × rate`).  The rounder
     * — chosen as the matched invoice with the highest invoice_id so it
     * always lands on the LAST line of the id-sorted display — instead
     * receives `target − Σ(others)` (computed in integer cents).  This
     * guarantees the combination sums exactly to the transaction amount
     * and absorbs both the true residual and any per-line cent rounding
     * into a single, predictable line.  The 1-currency-unit tolerance
     * enforced by findBestMatch caps the absorbed amount.
     */
    function stampApplyAmounts(invoices, matchedIndices, target, whtContext) {
        if (!whtContext) {
            for (var i = 0; i < matchedIndices.length; i++) {
                var idx = matchedIndices[i];
                invoices[idx].suggested = true;
                invoices[idx].apply_amount = roundToCents(
                    parseFloat(invoices[idx].invoice_unpaid_balance) || 0
                );
            }
            return;
        }

        var rounderIdx = pickRounderIndex(invoices, matchedIndices);

        var targetCents = Math.round(target * 100);
        var sumOfOthersCents = 0;

        for (var j = 0; j < matchedIndices.length; j++) {
            var mIdx = matchedIndices[j];
            invoices[mIdx].suggested = true;

            if (mIdx === rounderIdx) continue;

            var cents = applyCentsFor(invoices[mIdx], whtContext);
            invoices[mIdx].apply_amount = centsToAmount(cents);
            sumOfOthersCents += cents;
        }

        invoices[rounderIdx].apply_amount = centsToAmount(targetCents - sumOfOthersCents);
    }

    /**
     * Picks the matched invoice that will absorb the rounding residual.
     * Today: the matched invoice with the highest invoice_id, so the
     * adjustment is always on the LAST line of the id-sorted display.
     */
    function pickRounderIndex(invoices, matchedIndices) {
        var rounderIdx = matchedIndices[0];
        for (var i = 1; i < matchedIndices.length; i++) {
            var candidateIdx = matchedIndices[i];
            var candidateId = parseInt(invoices[candidateIdx].invoice_id, 10) || 0;
            var currentId = parseInt(invoices[rounderIdx].invoice_id, 10) || 0;
            if (candidateId > currentId) rounderIdx = candidateIdx;
        }
        return rounderIdx;
    }

    /**
     * Converts integer cents to a clean two-decimal currency value
     * (avoids `3129816 / 100 = 31298.159999999998` artefacts).
     */
    function centsToAmount(cents) {
        return parseFloat((cents / 100).toFixed(2));
    }

    /**
     * Rounds a currency amount to the nearest cent (defensive — callers
     * may pass values with floating-point noise like 31906.339999999999).
     */
    function roundToCents(amount) {
        return Math.round(amount * 100) / 100;
    }

    return {
        matchInvoicesToTransactions: matchInvoicesToTransactions
    };
});
