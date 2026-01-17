// Replaced Firebase Function call with direct API call to Vercel Serverless Function
// This ensures the backend exists relative to the frontend deployment on Vercel

export const createPaymentIntent = async (amount: number) => {
  try {
    // Call the serverless function located at /api/create-payment-intent
    const response = await fetch('/api/create-payment-intent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ amount }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = "Payment server error";
      try {
          const json = JSON.parse(errorText);
          if (json.error) errorMessage = json.error;
      } catch (e) {}
      throw new Error(errorMessage);
    }

    const data = await response.json();
    
    if (!data.clientSecret) {
        throw new Error("Invalid response from payment provider");
    }

    return data.clientSecret;
  } catch (error: any) {
    console.error("Payment initialization failed:", error);
    throw new Error(error.message || "Payment service unavailable. Please try again.");
  }
};