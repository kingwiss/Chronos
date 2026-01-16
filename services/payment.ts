import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from '../lib/firebase';

export const createPaymentIntent = async (amount: number) => {
  const functions = getFunctions(app);
  // Ensure your Firebase Function is deployed and named 'createPaymentIntent'
  const createPaymentIntentFunction = httpsCallable(functions, 'createPaymentIntent');
  
  try {
    const result: any = await createPaymentIntentFunction({ amount });
    
    if (!result.data || !result.data.clientSecret) {
      throw new Error("Invalid response from payment server. Please try again.");
    }

    return result.data.clientSecret;
  } catch (error: any) {
    console.error("Payment initialization failed:", error);
    // Propagate the real error to the UI
    throw new Error(error.message || "Payment service unavailable.");
  }
};