import re

with open("contracts/lending/src/test.rs", "r", encoding="utf-8") as f:
    content = f.read()

def replacer(match):
    prefix = match.group(1)
    borrower = match.group(2)
    amount = match.group(3).strip('&')
    duration = match.group(4).strip('&')
    rate = match.group(5).strip('&')
    max_loan = match.group(6).strip('&')
    asset = match.group(7).strip('&')
    collateral = match.group(8).strip('&')
    
    return f"""{prefix}client.create_loan_request(
        {borrower},
        &LoanRequestInput {{
            amount: {amount},
            duration_days: {duration},
            interest_rate_bps: {rate},
            max_loan_amount: {max_loan},
            collateral_asset: {asset},
            collateral_amount: {collateral},
        }}
    )"""

# The regex needs to capture the call arguments.
# format is typically: client.create_loan_request(&borrower, &principal, &days, &rate_bps, &max_loan, &collateral_asset, &100_000_0000000);
# Or sometimes it spans multiple lines. Let's make it robust or just do it generically.
# We know the arguments are: borrower, amount, duration, rate, max_loan, asset, collateral
pattern = r"(.*?)\bclient\.create_loan_request\s*\(\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^,)]+)\)"
content = re.sub(pattern, replacer, content, flags=re.DOTALL)

with open("contracts/lending/src/test.rs", "w", encoding="utf-8") as f:
    f.write(content)
