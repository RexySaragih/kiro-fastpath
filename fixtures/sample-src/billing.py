class InvoiceService:
    def create_invoice(self, user_id: str, amount: float) -> dict:
        return {"user_id": user_id, "amount": amount}


def calculate_tax(amount: float, rate: float = 0.1) -> float:
    return amount * rate
