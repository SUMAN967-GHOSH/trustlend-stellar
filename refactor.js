const fs = require('fs');
let content = fs.readFileSync('contracts/lending/src/test.rs', 'utf8');

const pattern = /(.*?)\bclient\.create_loan_request\s*\(\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^,)]+)\)/gs;

content = content.replace(pattern, (match, prefix, borrower, amount, duration, rate, max_loan, asset, collateral) => {
    return `${prefix}client.create_loan_request(
        ${borrower.trim()},
        &LoanRequestInput {
            amount: ${amount.trim().replace(/^&/, '')},
            duration_days: ${duration.trim().replace(/^&/, '')},
            interest_rate_bps: ${rate.trim().replace(/^&/, '')},
            max_loan_amount: ${max_loan.trim().replace(/^&/, '')},
            collateral_asset: ${asset.trim().replace(/^&/, '')},
            collateral_amount: ${collateral.trim().replace(/^&/, '')},
        }
    )`;
});

fs.writeFileSync('contracts/lending/src/test.rs', content, 'utf8');
