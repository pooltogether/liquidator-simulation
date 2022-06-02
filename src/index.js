#!/usr/bin/env node
const chalk = require('chalk')
const { stringify } = require("csv-stringify")
const { Command } = require('commander')
const program = new Command()
const fs = require("fs");

program.name('liquidator simulation')
    .description('simulates the PoolTogether liquidation algorithm')

program
    .option(
        '-d, --duration <number>',
        'The number of time units to run for',
        1000
    )
    .option(
        '-a, --ema-alpha <number>',
        'adjust how “reactive” the yield moving average is. Higher alpha means more weighting on recent values. Low alpha means broader, more smoothed average',
        0.7
    )
    .option(
        '-s, --swap-multiplier <number>',
        'This determines how quickly the price tracks downward market swings. Higher values also mean that more yield is left unsold, due to price impact.',
        0.3
    )
    .option(
        '-l, --liquidity-fraction <number>',
        'Determines the size of virtual LP to the average yield. Lower values make for efficient swaps, but it will track downward price swings poorly.',
        0.02
    )
    .option(
        '-o, --output-csv <path>',
        'outputs a csv file'
    )

program.parse()

const options = program.opts()

function dim(...args) {
    console.log(chalk.dim(...args))
}

// given an input amount of an asset and pair reserves, returns the maximum output amount of the other asset
function getAmountOut(amountIn, x, y) {
    return (amountIn * y) / (x + amountIn);
}

// given an output amount of an asset and pair reserves, returns a required input amount of the other asset
function getAmountIn(amountOut, reserveIn, reserveOut) {
    return (reserveIn * amountOut) / (reserveOut - amountOut)
}

/// @notice marketRate is yield / pool
function computeTradeProfit(poolAmountIn, yieldAmountOut, marketRate) {
    const poolCostInTermsOfYield = poolAmountIn * marketRate
    return yieldAmountOut > poolCostInTermsOfYield ? yieldAmountOut - poolCostInTermsOfYield : 0
}

function buyback(accruedYield, cpmm) {
    // swapping yield for pool
    const poolAmountOut = getAmountOut(accruedYield, cpmm.yieldVirtualReserve, cpmm.poolVirtualReserve)
    // console.log(chalk.cyan(`$$$ Buyback ${poolAmountOut} POOL for ${accruedYield} USDC`))
    return {
        ...cpmm,
        yieldVirtualReserve: cpmm.yieldVirtualReserve + accruedYield,
        poolVirtualReserve: cpmm.poolVirtualReserve - poolAmountOut
    }
}

function swap(yieldAmountOut, accruedYield, cpmm) {

    // buyback
    cpmm = buyback(accruedYield, cpmm)

    // swap
    const poolAmountIn = getAmountIn(yieldAmountOut, cpmm.poolVirtualReserve, cpmm.yieldVirtualReserve)
    const yieldVirtualReserve = cpmm.yieldVirtualReserve - yieldAmountOut
    const poolVirtualReserve = cpmm.poolVirtualReserve + poolAmountIn
    // dim(`swap k: ${parseInt(poolVirtualReserve * yieldVirtualReserve)}`)

    // Apply downward pressure to drive price down.
    const swapMultiplier = parseFloat(options.swapMultiplier)
    const additionalDownwardPressureYieldOut = yieldAmountOut*swapMultiplier
    const additionalDownwardPressurePoolIn = getAmountIn(additionalDownwardPressureYieldOut, poolVirtualReserve, yieldVirtualReserve)
    const yieldVirtualReserveWithDownwardPressure = yieldVirtualReserve - additionalDownwardPressureYieldOut
    const poolVirtualReserveWithDownwardPressure = poolVirtualReserve + additionalDownwardPressurePoolIn

    // accrued yield is a sawtooth. So we apply a low-pass filter to calculate a moving average. over X seconds.
    const emaAlpha = parseFloat(options.emaAlpha)
    const accruedYieldMovingAverage = (accruedYield * emaAlpha) + (cpmm.accruedYieldMovingAverage*(1-emaAlpha))

    // now, we want to ensure that the accrued yield is always a small fraction of virtual LP position.
    const liquidityFraction = parseFloat(options.liquidityFraction)
    const multiplier = accruedYieldMovingAverage / (yieldVirtualReserveWithDownwardPressure*liquidityFraction)

    const resultCpmm = {
        yieldVirtualReserve: multiplier * yieldVirtualReserveWithDownwardPressure,
        poolVirtualReserve: multiplier * poolVirtualReserveWithDownwardPressure,
        accruedYieldMovingAverage
    }

    return resultCpmm
}

function computeExactAmountIn(yieldAmountOut, accruedYield, cpmm) {
    cpmm = buyback(accruedYield, cpmm)
    // now run the user swap
    return getAmountIn(yieldAmountOut, cpmm.poolVirtualReserve, cpmm.yieldVirtualReserve)
}

function findOptimalAmountOut(accruedYield, cpmm, marketRate) {
    let bestYieldAmountOut = 0
    let bestPoolAmountIn = 0
    let bestProfit = 0
    // steps of 1%
    let stepSize = 0.1 * accruedYield
    for (let yieldAmountOut = stepSize; yieldAmountOut <= accruedYield; yieldAmountOut += stepSize) {
        const poolAmountIn = computeExactAmountIn(yieldAmountOut, accruedYield, cpmm)
        const profit = computeTradeProfit(poolAmountIn, yieldAmountOut, marketRate)
        // dim(`Trading ${poolAmountIn} for ${yieldAmountOut} with profit of ${profit}`)
        if (profit > bestProfit) {
            bestYieldAmountOut = yieldAmountOut
            bestPoolAmountIn = poolAmountIn
            bestProfit = profit
        }
    }
    return {
        yieldAmountOut: bestYieldAmountOut,
        poolAmountIn: bestPoolAmountIn,
        profit: bestProfit
    }
}

async function run() {

    let marketRates = {
        0: 10,
        50: 12,
        80: 14,
        100: 16,
        140: 18,
        150: 20,
        180: 22,
        200: 24,
        240: 26,
        280: 28,
        320: 30,
        350: 32,
        400: 30,
        450: 22,
        500: 16,
        600: 10,
        700: 8
    }

    let accrualRates = {
        0: 10,
        // 50: 20,
        100: 100,
        // 150: 80,
        // 200: 160,
        400: 1000,
        // 300: 640,
        800: 10000
    }

    // x = yield
    // y = POOL
    // higher virtual LP values mean 
    let cpmm = {
        yieldVirtualReserve: 500,
        poolVirtualReserve: 50,
        accruedYieldMovingAverage: 0
    }

    const MIN_PROFIT = 1

    let marketRate = marketRates[0]
    let accrualRate = accrualRates[0]
    let accruedYield = 0

    let poolIncome = 0
    let arbCount = 0

    const duration = parseInt(options.duration)
    let writeableStream, stringifier
    if (options.outputCsv) {
        writeableStream = fs.createWriteStream(options.outputCsv)
        const columns = [
            'time',
            'yield_accrual_rate',
            'available_yield',
            'swap_amount_out',
            'swap_amount_in',
            'swap_exchange_rate',
            'market_exchange_rate',
            'efficiency',
            'moving_average',
            'yield_virtual_liquidity',
            'token_virtual_liquidity',
            'unsold_yield'
        ]
        stringifier = stringify({ header: true, columns: columns });
    }

    for (let time = 0; time < duration; time++) {
        if (marketRates[time] > 0) {
            marketRate = marketRates[time]
        }
        if (accrualRates[time] > 0) {
            accrualRate = accrualRates[time]
        }
        accruedYield += accrualRate

        const {
            yieldAmountOut,
            poolAmountIn,
            profit
        } = findOptimalAmountOut(accruedYield, cpmm, marketRate)
        
        if (profit >= MIN_PROFIT) {
            const availableYield = accruedYield
            arbCount++;
            cpmm = swap(yieldAmountOut, accruedYield, cpmm)
            let swapExchangeRate = yieldAmountOut / poolAmountIn
            poolIncome += poolAmountIn
            let efficiency = marketRate / swapExchangeRate
            accruedYield -= yieldAmountOut

            if (stringifier) {
                const args = [
                    time,
                    accrualRate,
                    availableYield,
                    yieldAmountOut,
                    poolAmountIn,
                    swapExchangeRate,
                    marketRate,
                    efficiency,
                    cpmm.accruedYieldMovingAverage,
                    cpmm.yieldVirtualReserve,
                    cpmm.poolVirtualReserve,
                    accruedYield
                ].map(a => a.toString())
                stringifier.write(args)
            }

            const details = [
                `@ ${time} efficiency ${parseInt(efficiency * 100)}`,
                `moving average: ${cpmm.accruedYieldMovingAverage}`,
                `vr yield: ${cpmm.yieldVirtualReserve}`,
                `vr pool: ${cpmm.poolVirtualReserve}`,
                // `sold ${poolAmountIn} POOL`,
                // `bought ${yieldAmountOut} USDC`,
                // `profit ${profit} USDC`, 
                `swapExchangeRate ${swapExchangeRate}`,
                `remainingYield ${accruedYield}`
            ]
            // console.log(chalk.green(details.join('\n\t')))
        }
    }

    if (stringifier) {
        stringifier.pipe(writeableStream)
    }

    console.log(chalk.cyan(`\n${arbCount} arbs brought in ${poolIncome} POOL`))
}

run()