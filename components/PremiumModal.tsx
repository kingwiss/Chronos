import React, { useState } from 'react';
import { X, Check, Sparkles, Loader2, Zap, Lock } from 'lucide-react';
import { setPremiumStatus } from '../services/storage';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { createPaymentIntent } from '../services/payment';

// Initialize Stripe with Publishable Key
const stripePromise = loadStripe('pk_live_51RbXymG32OfZ6BeqReYzIqhjytur4Ia8lwQypqB5jE8IXSmEHg9NCmNlXi7jECSAqiCHZSsAgkA14K27w9Rms0k1004uJJJ2ng');

interface PremiumModalProps {
  onClose: () => void;
  onSuccess: () => void;
  isDarkMode: boolean;
}

const CheckoutForm: React.FC<{ onSuccess: () => void; onClose: () => void; isDarkMode: boolean }> = ({ onSuccess, onClose, isDarkMode }) => {
    const stripe = useStripe();
    const elements = useElements();
    const [isProcessing, setIsProcessing] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();

        if (!stripe || !elements) return;

        setIsProcessing(true);
        setErrorMessage('');

        try {
            const { error, paymentIntent } = await stripe.confirmPayment({
                elements,
                redirect: 'if_required'
            });

            if (error) {
                setErrorMessage(error.message || "Payment failed");
            } else if (paymentIntent && paymentIntent.status === 'succeeded') {
                await setPremiumStatus(true);
                onSuccess();
                onClose();
            }
        } catch (e: any) {
            setErrorMessage(e.message || "An unexpected error occurred.");
        } finally {
            setIsProcessing(false);
        }
    };

    return (
        <form onSubmit={handleSubmit} className="w-full space-y-6">
            <div className={`p-4 rounded-xl border ${isDarkMode ? 'bg-zinc-800 border-zinc-700' : 'bg-zinc-50 border-zinc-200'}`}>
                <PaymentElement 
                    options={{
                        theme: isDarkMode ? 'night' : 'stripe',
                        layout: 'tabs'
                    }} 
                />
            </div>
            
            {errorMessage && (
                <div className="text-red-500 text-xs text-center p-2 bg-red-500/10 rounded-lg">
                    {errorMessage}
                </div>
            )}

            <button 
                type="submit" 
                disabled={!stripe || isProcessing}
                className="w-full py-4 rounded-xl font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-500/30 transition-all active:scale-95 flex items-center justify-center gap-2 disabled:opacity-50"
            >
                {isProcessing ? <Loader2 className="w-5 h-5 animate-spin" /> : (
                    <>
                        <Lock className="w-4 h-4" />
                        <span>Pay $6.99</span>
                    </>
                )}
            </button>
        </form>
    );
};

export const PremiumModal: React.FC<PremiumModalProps> = ({ onClose, onSuccess, isDarkMode }) => {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [isLoadingSecret, setIsLoadingSecret] = useState(false);
  const [initError, setInitError] = useState('');

  const initializePayment = async () => {
      setIsLoadingSecret(true);
      setInitError('');
      try {
          // In a real app, this calls your backend. Here we simulate the backend call.
          const secret = await createPaymentIntent(699); // $6.99 in cents
          setClientSecret(secret);
      } catch (e: any) {
          console.error(e);
          setInitError("Unable to initialize payment system. CORS policy on the demo environment may be blocking direct Stripe API calls. Please deploy the backend code.");
      } finally {
          setIsLoadingSecret(false);
      }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-indigo-900/60 backdrop-blur-md animate-in fade-in">
      <div className={`w-full max-w-md p-8 rounded-3xl relative shadow-2xl overflow-y-auto max-h-[90vh] ${isDarkMode ? 'bg-zinc-900 border border-indigo-500/30' : 'bg-white border border-indigo-200'}`}>
        
        {/* Decorative Background */}
        <div className="absolute top-0 left-0 right-0 h-32 bg-gradient-to-b from-indigo-600/20 to-transparent pointer-events-none"></div>
        
        <button onClick={onClose} className={`absolute top-4 right-4 z-10 p-2 rounded-full ${isDarkMode ? 'text-zinc-500 hover:text-white hover:bg-zinc-800' : 'text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100'}`}>
          <X className="w-6 h-6" />
        </button>

        <div className="text-center mb-6 relative z-10">
          <div className="w-12 h-12 bg-indigo-600 rounded-full flex items-center justify-center mx-auto mb-3 shadow-lg shadow-indigo-500/40">
             <Sparkles className="text-white w-6 h-6" />
          </div>
          <h2 className={`text-2xl font-black tracking-tight ${isDarkMode ? 'text-white' : 'text-zinc-900'}`}>
            Upgrade to Premium
          </h2>
        </div>

        {!clientSecret ? (
            <div className="space-y-6">
                <div className={`space-y-4 ${isDarkMode ? 'text-zinc-300' : 'text-zinc-600'}`}>
                    <div className="flex items-center gap-3">
                    <div className="p-1 rounded-full bg-indigo-500/20 text-indigo-500"><Check className="w-4 h-4" /></div>
                    <span className="text-sm">Unlimited Voice Agent Sessions</span>
                    </div>
                    <div className="flex items-center gap-3">
                    <div className="p-1 rounded-full bg-indigo-500/20 text-indigo-500"><Check className="w-4 h-4" /></div>
                    <span className="text-sm">Unlimited AI Note Generation</span>
                    </div>
                    <div className="flex items-center gap-3">
                    <div className="p-1 rounded-full bg-indigo-500/20 text-indigo-500"><Check className="w-4 h-4" /></div>
                    <span className="text-sm">Smart Image Analysis</span>
                    </div>
                </div>

                <div className="text-center">
                    <span className={`text-3xl font-bold ${isDarkMode ? 'text-white' : 'text-zinc-900'}`}>$6.99</span>
                    <span className={`text-sm ${isDarkMode ? 'text-zinc-500' : 'text-zinc-400'}`}> / month</span>
                </div>
                
                {initError && <div className="text-xs text-red-500 text-center px-4">{initError}</div>}

                <button 
                    onClick={initializePayment}
                    disabled={isLoadingSecret}
                    className="w-full py-4 rounded-xl font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-500/30 transition-all active:scale-95 flex items-center justify-center gap-2"
                >
                    {isLoadingSecret ? <Loader2 className="w-5 h-5 animate-spin" /> : (
                        <>
                            <Zap className="w-5 h-5 fill-current" />
                            <span>Proceed to Checkout</span>
                        </>
                    )}
                </button>
            </div>
        ) : (
            <div className="animate-in fade-in slide-in-from-bottom-4">
                 <Elements stripe={stripePromise} options={{ clientSecret, appearance: { theme: isDarkMode ? 'night' : 'stripe' } }}>
                    <CheckoutForm onSuccess={onSuccess} onClose={onClose} isDarkMode={isDarkMode} />
                 </Elements>
                 <button onClick={() => setClientSecret(null)} className={`mt-4 w-full text-xs hover:underline ${isDarkMode ? 'text-zinc-500' : 'text-zinc-400'}`}>
                     Go Back
                 </button>
            </div>
        )}
        
        <p className={`text-center text-[10px] mt-6 ${isDarkMode ? 'text-zinc-600' : 'text-zinc-400'}`}>
            Secured by Stripe. Recurring billing. Cancel anytime.
        </p>
      </div>
    </div>
  );
};