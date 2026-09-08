"use strict";
/**
 * SOTA Lo-MacKinlay Online Variance Ratio Regime Classifier (DEF-R5)
 *
 * Implements the Lo & MacKinlay (1988) Variance Ratio test in a zero-GC,
 * online streaming architecture with exponential moving average (EWMA) variances.
 *
 * In crypto microstructure:
 * - VR(k) < 0.75: Strong Mean-Reversion (Chop / Noise / Bid-Ask bounce). Negative serial autocorrelation.
 * - 0.75 <= VR(k) <= 1.30: Random Walk (Martingale / Efficient market). Zero serial correlation.
 * - VR(k) > 1.30: Trending (Momentum / Persistent drift). Positive serial autocorrelation.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OnlineVarianceRatioClassifier = void 0;
class OnlineVarianceRatioClassifier {
    k;
    windowSize;
    alpha;
    // Zero-GC fixed ring buffer for price history
    priceRing;
    head = 0;
    count = 0;
    // Online EWMA statistics for 1-period and k-period log-returns
    ewmaMean1 = 0.0;
    ewmaVar1 = 0.0;
    ewmaMeanK = 0.0;
    ewmaVarK = 0.0;
    // Last computed variance ratio
    cachedVR = 1.0;
    constructor(k = 5, windowSize = 60, alpha = 0.02) {
        if (k < 2) {
            throw new Error(`Variance Ratio period k must be >= 2, received ${k}`);
        }
        if (windowSize < k + 2) {
            throw new Error(`Window size (${windowSize}) must be >= k + 2 (${k + 2})`);
        }
        this.k = k;
        this.windowSize = windowSize;
        this.alpha = Math.max(0.001, Math.min(0.5, alpha));
        this.priceRing = new Float64Array(this.windowSize);
    }
    /**
     * Online update with latest mid-price on every orderbook tick.
     * Zero heap allocation hot path.
     */
    updatePrice(midPrice) {
        if (!Number.isFinite(midPrice) || midPrice <= 0) {
            return;
        }
        if (this.count === 0) {
            this.priceRing[0] = midPrice;
            this.head = 1 % this.windowSize;
            this.count = 1;
            this.cachedVR = 1.0;
            return;
        }
        const prevPriceIdx = (this.head - 1 + this.windowSize) % this.windowSize;
        const prevPrice = this.priceRing[prevPriceIdx];
        // Filter out zero-return depth updates (DEF-3104): Lo-MacKinlay requires real price increments
        // to prevent exponential decay of return variances toward zero during quiet orderbook periods.
        if (Math.abs(midPrice - prevPrice) < 1e-9) {
            return;
        }
        // Compute 1-period log return: r_1 = ln(p_t / p_{t-1})
        const r1 = Math.log(midPrice / prevPrice);
        // Update 1-period EWMA variance (Welford-West online algorithm)
        if (this.count === 1) {
            this.ewmaMean1 = r1;
            this.ewmaVar1 = Math.max(1e-12, r1 * r1);
        }
        else {
            const diff1 = r1 - this.ewmaMean1;
            this.ewmaMean1 += this.alpha * diff1;
            this.ewmaVar1 = (1.0 - this.alpha) * this.ewmaVar1 + this.alpha * (r1 - this.ewmaMean1) * diff1;
            if (this.ewmaVar1 < 1e-12) {
                this.ewmaVar1 = 1e-12;
            }
        }
        // Compute k-period log return: r_k = ln(p_t / p_{t-k})
        if (this.count >= this.k) {
            const kAgoIdx = (this.head - this.k + this.windowSize) % this.windowSize;
            const kAgoPrice = this.priceRing[kAgoIdx];
            const rk = Math.log(midPrice / kAgoPrice);
            if (this.count === this.k) {
                this.ewmaMeanK = rk;
                this.ewmaVarK = Math.max(1e-12, rk * rk);
            }
            else {
                const diffK = rk - this.ewmaMeanK;
                this.ewmaMeanK += this.alpha * diffK;
                this.ewmaVarK = (1.0 - this.alpha) * this.ewmaVarK + this.alpha * (rk - this.ewmaMeanK) * diffK;
                if (this.ewmaVarK < 1e-12) {
                    this.ewmaVarK = 1e-12;
                }
            }
            // Compute Lo-MacKinlay Variance Ratio: VR(k) = Var(r_k) / (k * Var(r_1))
            const denom = this.k * this.ewmaVar1;
            this.cachedVR = denom > 1e-12 ? this.ewmaVarK / denom : 1.0;
        }
        else {
            this.cachedVR = 1.0;
        }
        // Store midPrice in circular buffer
        this.priceRing[this.head] = midPrice;
        this.head = (this.head + 1) % this.windowSize;
        if (this.count < this.windowSize) {
            this.count++;
        }
    }
    /**
     * Returns current Variance Ratio: VR(k) = Var(r_k) / (k * Var(r_1)).
     */
    getVarianceRatio() {
        return this.cachedVR;
    }
    /**
     * Classifies market regime into 3 distinct operational states:
     * - MEAN_REVERT: VR < 0.75 (chop, toxic noise, negative autocorrelation)
     * - RANDOM_WALK: 0.75 <= VR <= 1.30 (martingale, no directional edge)
     * - TRENDING: VR > 1.30 (momentum, persistent autocorrelation)
     */
    getRegimeState() {
        // Require minimum history (k + 2 samples) before asserting non-random regime
        if (this.count < this.k + 2) {
            return "RANDOM_WALK";
        }
        const vr = this.cachedVR;
        if (vr < 0.75) {
            return "MEAN_REVERT";
        }
        if (vr > 1.30) {
            return "TRENDING";
        }
        return "RANDOM_WALK";
    }
    getCount() {
        return this.count;
    }
    getEwmaVar1() {
        return this.ewmaVar1;
    }
    getEwmaVarK() {
        return this.ewmaVarK;
    }
    reset() {
        this.head = 0;
        this.count = 0;
        this.ewmaMean1 = 0.0;
        this.ewmaVar1 = 0.0;
        this.ewmaMeanK = 0.0;
        this.ewmaVarK = 0.0;
        this.cachedVR = 1.0;
        this.priceRing.fill(0);
    }
}
exports.OnlineVarianceRatioClassifier = OnlineVarianceRatioClassifier;
