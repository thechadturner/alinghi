import { createSignal, onMount, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { logPageLoad } from "../utils/logging";
import { error as logError, log } from "../utils/console";
import { getData, putData, postData } from "../utils/global";
import Loading from "../components/utilities/Loading";
import BackButton from "../components/buttons/BackButton";
import ThemeToggle from "../components/utilities/ThemeToggle";
import { user, subscription, setSubscription } from "../store/userStore";
import { apiEndpoints } from "@config/env";

interface SubscriptionLevel {
    id: string;
    name: string;
    description: string;
    price: string;
    features: string[];
    icon: string;
    color: string;
    hoverColor: string;
    background?: string;
    textColor?: string;
    selectable: boolean;
    current?: boolean;
    contactEmail?: string;
}

interface UserData {
    user_name: string;
    first_name: string;
    last_name: string;
    email: string;
}

interface InvoiceData {
    street: string;
    city: string;
    postal: string;
    country: string;
    taxId: string;
}

interface InvoiceTags {
    invoice?: {
        'street address'?: string;
        'city'?: string;
        'postal code'?: string;
        'country'?: string;
        'tax id'?: string;
    };
}

// Subscription level definitions
const subscriptionLevels: SubscriptionLevel[] = [
    {
        id: 'member',
        name: 'MEMBER',
        description: 'Invited Team Member',
        price: 'Free',
        features: ['View Only Access'],
        icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z',
        color: 'linear-gradient(135deg, #6b7280 0%, #4b5563 100%)',
        hoverColor: 'linear-gradient(135deg, #9ca3af 0%, #6b7280 100%)',
        background: '#f9fafb',
        textColor: '#000000',
        selectable: false,
        current: false
    },
    {
        id: 'free',
        name: 'FREE',
        description: 'Create your own project and explore the AC37 demo dataset',
        price: 'Free',
        features: ['1 User', '1 Boat', '3 Days', 'AC37 Demo Dataset'],
        icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z',
        color: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
        hoverColor: 'linear-gradient(135deg, #34d399 0%, #10b981 100%)',
        selectable: true,
        current: false
    },
    {
        id: 'standard',
        name: 'STANDARD',
        description: 'Multi-user / Multi-day analysis & collaboration',
        price: '€5 / sailing day',
        features: ['Multi User', '1 Boat', '1 Class', 'Multi Day', 'Fleet Comparisons'],
        icon: 'M16 4c0-1.11.89-2 2-2s2 .89 2 2-.89 2-2 2-2-.89-2-2zm4 18v-6h2.5l-2.54-7.63A1.5 1.5 0 0 0 18.54 8H17c-.8 0-1.54.37-2.01.99L12 11l-2.99-2.01A2.5 2.5 0 0 0 7 8H5.46c-.8 0-1.54.37-2.01.99L1 15.37V22h2v-6h2.5l2.5 7.5h2L8.5 16H11v6h2zm-6.5 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z',
        color: 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)',
        hoverColor: 'linear-gradient(135deg, #60a5fa 0%, #3b82f6 100%)',
        selectable: true,
        current: false
    },
    {
        id: 'pro',
        name: 'PRO',
        description: 'Professional level tools & debriefing',
        price: '€50 / sailing day',
        features: ['Standard edition +', 'Multi Boat', 'Multi Class', 'Video Replay', 'Fleet Comparisons', 'API Access', 'Basic Support'],
        icon: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
        color: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
        hoverColor: 'linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%)',
        selectable: true,
        current: false
    },
    {
        id: 'enterprise',
        name: 'ENTERPRISE',
        description: 'Dedicated server solution - Campaign Edition',
        price: 'Contact Us',
        features: ['All Features', 'Dedicated Server', 'Priority Support', 'Custom Integrations'],
        icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.94-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z',
        color: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
        hoverColor: 'linear-gradient(135deg, #f87171 0%, #ef4444 100%)',
        selectable: false,
        contactEmail: 'mailto:contact@teamshare.com?subject=Enterprise Subscription Inquiry',
        current: false
    }
];

// Constant to show/hide subscription levels and additional options sections
const SHOW_SUBSCRIPTION_SECTIONS = false;

export default function Profile() {
    const navigate = useNavigate();
    const [user_name, setUserName] = createSignal("");
    const [first_name, setFirstName] = createSignal("");
    const [last_name, setLastName] = createSignal("");
    const [email, setEmail] = createSignal("");
    const [apiKey, setApiKey] = createSignal("");
    const [hashedApiKey, setHashedApiKey] = createSignal("");
    const [showToken, setShowToken] = createSignal(false);
    const [copyStatus, setCopyStatus] = createSignal("");
    // Invoice signals for paid plans
    const [invoiceStreet, setInvoiceStreet] = createSignal("");
    const [invoiceCity, setInvoiceCity] = createSignal("");
    const [invoicePostal, setInvoicePostal] = createSignal("");
    const [invoiceCountry, setInvoiceCountry] = createSignal("");
    const [invoiceTaxId, setInvoiceTaxId] = createSignal("");
    
    // Original values for change detection
    const [originalUserData, setOriginalUserData] = createSignal<UserData>({
        user_name: "",
        first_name: "",
        last_name: "",
        email: ""
    });
    const [originalInvoiceData, setOriginalInvoiceData] = createSignal<InvoiceData>({
        street: "",
        city: "",
        postal: "",
        country: "",
        taxId: ""
    });

    const fetchProfileData = async () => {
        const controller = new AbortController();
        
        try {
            // Check if user is available
            const currentUser = user();
            if (!currentUser || !currentUser.user_id) {
                logError("Profile: User not available, cannot fetch profile data");
                // Try to redirect to login if not logged in
                if (!currentUser) {
                    navigate('/login');
                }
                return;
            }
            
            let response = await getData(`${apiEndpoints.app.users}?id=${currentUser.user_id}`, controller.signal)
            let data = response.data;

            if (!response.success) throw new Error("Failed to fetch user data");

            setUserName(data.user_name);
            setFirstName(data.first_name);
            setLastName(data.last_name);
            setEmail(data.email);
            
            // Store original values for change detection
            setOriginalUserData({
                user_name: data.user_name || "",
                first_name: data.first_name || "",
                last_name: data.last_name || "",
                email: data.email || ""
            });

            // Fetch and select current subscription so the correct tile is highlighted
            try {
                const currentUser = user();
                if (!currentUser || !currentUser.user_id) {
                    setSubscription('free');
                    return;
                }
                const subRes = await getData(`${apiEndpoints.app.users}/subscription?id=${currentUser.user_id}`, controller.signal);
                // Controller returns value or 'none'; default to 'free'
                const subValue = subRes?.data ?? 'free';
                setSubscription(typeof subValue === 'string' ? (subValue === 'none' ? 'free' : subValue) : (subValue?.plan || 'free'));
            } catch (e) {
                setSubscription('free');
            }

            // Prefill invoice tags if present
            try {
                const tags = data?.tags ? (typeof data.tags === 'string' ? JSON.parse(data.tags) : data.tags) : null;
                const invoice = tags?.invoice;
                if (invoice) {
                    setInvoiceStreet(invoice['street address'] || "");
                    setInvoiceCity(invoice['city'] || "");
                    setInvoicePostal(invoice['postal code'] || "");
                    setInvoiceCountry(invoice['country'] || "");
                    setInvoiceTaxId(invoice['tax id'] || "");
                    
                    // Store original invoice values
                    setOriginalInvoiceData({
                        street: invoice['street address'] || "",
                        city: invoice['city'] || "",
                        postal: invoice['postal code'] || "",
                        country: invoice['country'] || "",
                        taxId: invoice['tax id'] || ""
                    });
                } else {
                    setInvoiceStreet("");
                    setInvoiceCity("");
                    setInvoicePostal("");
                    setInvoiceCountry("");
                    setInvoiceTaxId("");
                    
                    // Store original empty values
                    setOriginalInvoiceData({
                        street: "",
                        city: "",
                        postal: "",
                        country: "",
                        taxId: ""
                    });
                }
            } catch (_) {
                setInvoiceStreet("");
                setInvoiceCity("");
                setInvoicePostal("");
                setInvoiceCountry("");
                setInvoiceTaxId("");
                
                // Store original empty values
                setOriginalInvoiceData({
                    street: "",
                    city: "",
                    postal: "",
                    country: "",
                    taxId: ""
                });
            }

            // API key will only be available after creating a new token
            setHashedApiKey('');
            setApiKey('');

            await logPageLoad('Profile.tsx', 'Profile Page')
        } catch (error: any) {
            if (error.name === 'AbortError') {
            } else {
                logError("Error fetching user data:", error.message);
            }
        }
    };

    const handleUpdateProfile = async (e: Event) => {
        e.preventDefault();
        
        const controller = new AbortController();

        try {
            // Build invoice tags JSON for paid plans
            const subPlan = subscription();
            const planValue = typeof subPlan === 'string' ? subPlan : subPlan?.plan;
            const isPaid = ['standard', 'pro', 'standard_plus', 'pro_plus', 'enterprise'].includes(planValue);

            let tags: InvoiceTags | undefined = undefined;
            if (isPaid) {
                const invoice: { [key: string]: string | undefined } = {
                    'street address': invoiceStreet().trim() || undefined,
                    'city': invoiceCity().trim() || undefined,
                    'postal code': invoicePostal().trim() || undefined,
                    'country': invoiceCountry().trim() || undefined,
                    'tax id': invoiceTaxId().trim() || undefined,
                };
                // Remove undefined fields
                Object.keys(invoice).forEach(k => invoice[k] === undefined && delete invoice[k]);
                if (Object.keys(invoice).length > 0) {
                    tags = { invoice: invoice as InvoiceTags['invoice'] };
                }
            }

            const result = await putData(`${apiEndpoints.app.users}/update`, {
                id: user().user_id,
                user_name: user_name(),
                first_name: first_name(),
                last_name: last_name(),
                email: email(),
                ...(tags ? { tags: JSON.stringify(tags) } : {}),
            }, controller.signal)

            if (!result.success) {
                logError(`Failed to update profile:`, await result.message);
            } else {
                // Update original values after successful save
                setOriginalUserData({
                    user_name: user_name(),
                    first_name: first_name(),
                    last_name: last_name(),
                    email: email()
                });
                
                // Update original invoice values if they were included
                if (tags) {
                    const invoice = tags.invoice;
                    if (invoice) {
                        setOriginalInvoiceData({
                            street: invoice['street address'] || "",
                            city: invoice['city'] || "",
                            postal: invoice['postal code'] || "",
                            country: invoice['country'] || "",
                            taxId: invoice['tax id'] || ""
                        });
                    }
                }
                
                await logPageLoad('Profile.tsx', 'Profile Page', 'Updated')
                setTimeout(() => navigate(`/dashboard`, { replace: true }), 100);
            }
        } catch (error: any) {
            if (error.name === 'AbortError') {
            } else {
                logError("Error updating profile:", error);
            }
        }
    };

    const handleSubscriptionChange = async (subscriptionType: string) => {
        // Check if subscription is selectable
        const level = subscriptionLevels.find(l => l.id === subscriptionType);
        if (!level || !level.selectable) {
            if (level?.contactEmail) {
                // Open email for enterprise contact
                window.open(level.contactEmail, '_blank');
            }
            return;
        }

        // Update UI state immediately for better UX
        setSubscription(subscriptionType);

        const controller = new AbortController();

        try {
            const duration = subscriptionType === 'free' ? 0 : 360; // 360 days for paid plans
            let result = await putData(`${apiEndpoints.app.users}/update/subscription`, {
                id: user().user_id, 
                subscription_type: subscriptionType, 
                duration: duration
            }, controller.signal)

            if (result.success) {
                // State already updated above, no need to refresh
                log('Subscription updated successfully to:', subscriptionType);
            } else {
                logError("Failed to update subscription:", result.message);
                // Revert state on failure
                setSubscription('free'); // Default fallback
            }
        } catch (error: any) {
            if (error.name === 'AbortError') {
            } else {
                logError("Error updating subscription:", error);
                // Revert state on error
                setSubscription('free'); // Default fallback
            }
        }
    };

    const copyToClipboard = async () => {
        try {
          if (apiKey()) {
            await navigator.clipboard.writeText(apiKey());
            setCopyStatus("Copied!");
            setTimeout(() => setCopyStatus(""), 3000);
          }
        } catch (err: any) {
          setCopyStatus("Copy Failed");
          setTimeout(() => setCopyStatus(""), 3000);
        }
    };

    const createPersonalToken = async () => {
        try {
            const controller = new AbortController();
            const expires_in_days = 90;
            const payload = { name: `pat-${new Date().toISOString().slice(0,10)}`, scopes: ['upload','read','write'], expires_in_days };
            const res = await postData(`${apiEndpoints.admin.tokens}`, payload, controller.signal);
            if (res.success && res.data?.token) {
                // Show new token once; keep private thereafter
                setApiKey(res.data.token);
                setHashedApiKey(''); // Clear hashed key since we have the real one
                setShowToken(true); // Show the token immediately
                setCopyStatus('Token created. Copy and store it securely.');
                setTimeout(() => setCopyStatus(""), 6000);
            } else {
                setCopyStatus(res.message || 'Failed to create token');
                setTimeout(() => setCopyStatus(""), 6000);
            }
        } catch (e) {
            setCopyStatus('Error creating token');
            setTimeout(() => setCopyStatus(""), 6000);
        }
    };

    // Change detection functions
    const hasUserDataChanged = () => {
        const original = originalUserData();
        return (
            user_name() !== original.user_name ||
            first_name() !== original.first_name ||
            last_name() !== original.last_name ||
            email() !== original.email
        );
    };

    const hasInvoiceDataChanged = () => {
        const original = originalInvoiceData();
        return (
            invoiceStreet() !== original.street ||
            invoiceCity() !== original.city ||
            invoicePostal() !== original.postal ||
            invoiceCountry() !== original.country ||
            invoiceTaxId() !== original.taxId
        );
    };

    onMount(async () => {
        await fetchProfileData();
    });

    return (
        <>
            <style>{`
                .profile-layout {
                    display: grid;
                    grid-template-columns: ${SHOW_SUBSCRIPTION_SECTIONS ? '1fr 1fr' : '1fr'};
                    gap: 32px;
                    align-items: start;
                    flex: 1;
                    width: 100%;
                    max-width: 100%;
                    ${SHOW_SUBSCRIPTION_SECTIONS ? '' : 'justify-items: center;'}
                }
                ${SHOW_SUBSCRIPTION_SECTIONS ? '' : `
                .profile-layout > div:first-child {
                    max-width: 800px;
                    width: 100%;
                }
                `}
                /* Keep subscription + extras together in the right column */
                .right-column { 
                    grid-column: 2; 
                    display: flex; 
                    flex-direction: column; 
                    gap: 16px; 
                    min-width: 0; /* Allow column to shrink */
                }
                
                @media (max-width: 1200px) {
                    .profile-layout {
                        grid-template-columns: 1fr;
                        gap: 24px;
                        ${SHOW_SUBSCRIPTION_SECTIONS ? '' : 'justify-items: center;'}
                    }
                    .right-column { 
                        grid-column: 1; 
                    }
                }
                
                @media (max-width: 768px) {
                    .profile-layout {
                        gap: 16px;
                    }
                }
                
                @media (max-width: 480px) {
                    .profile-layout {
                        gap: 12px;
                    }
                }
                
                /* Ensure proper spacing from header */
                .profile-container {
                    padding-top: 80px;
                    min-height: calc(100vh - 80px);
                    height: auto;
                    overflow: visible;
                }
                
                /* Ensure smooth scrolling and proper scroll container */
                .login-page {
                    scroll-behavior: smooth;
                    position: relative;
                }
                
                /* Ensure body can scroll when content overflows */
                body {
                    overflow-x: hidden;
                    overflow-y: auto;
                }
                
                @media (max-width: 768px) {
                    .profile-container {
                        padding-top: 70px;
                        min-height: calc(100vh - 70px);
                    }
                }
                
                @media (max-width: 480px) {
                    .profile-container {
                        padding-top: 60px;
                        min-height: calc(100vh - 60px);
                        padding-left: 10px;
                        padding-right: 10px;
                    }
                    
                    /* Make subscription cards more mobile-friendly */
                    .subscription-card {
                        flex-direction: column;
                        text-align: center;
                        gap: 12px;
                    }
                    
                    .subscription-card .subscription-content {
                        flex-direction: column;
                        align-items: center;
                        text-align: center;
                    }
                }
            `}</style>
            <div class="login-page" style="
                min-height: calc(100vh - 60px);
                background: var(--color-bg-secondary);
                padding-top: 0;
                padding-bottom: 64px;
                box-sizing: border-box;
                transition: background-color 0.3s ease;
            ">
                <Show when={user()} fallback={<Loading />}>
                    <div class="login-page-scroll-container">
                    <div class="profile-container" style="
                        display: flex; 
                        flex-direction: column; 
                        min-height: 100%; 
                        height: auto;
                        padding: 20px;
                        max-width: 1400px;
                        margin: 0 auto;
                        box-sizing: border-box;
                    ">
                        <div class="login-header" style="margin-bottom: 24px;">
                            <div class="logo-section">
                                <div class="logo-icon">
                                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                        <path d="M20 21V19C20 17.9391 19.5786 16.9217 18.8284 16.1716C18.0783 15.4214 17.0609 15 16 15H8C6.93913 15 5.92172 15.4214 5.17157 16.1716C4.42143 16.9217 4 17.9391 4 19V21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                        <circle cx="12" cy="7" r="4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    </svg>
                                </div>
                                <h1 class="login-title">Profile Information</h1>
                                <p class="login-subtitle">Manage your account settings and preferences</p>
                            </div>
                        </div>
                        
                        <div class="profile-layout">
                        {/* Left Column - Three Sections */}
                        <div style="display: flex; flex-direction: column; gap: 16px;">
                            {/* User Preferences Section */}
                            <div style="
                                background: var(--color-bg-card); 
                                border-radius: 12px; 
                                padding: 24px; 
                                box-shadow: 0 2px 8px var(--color-shadow-sm);
                                border: 1px solid var(--color-border-primary);
                                transition: all 0.3s ease;
                            ">
                                <h3 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: var(--color-text-primary); transition: color 0.3s ease;">
                                    User Preferences
                                </h3>
                                <div style="width: 100%;">
                                    <ThemeToggle />
                                </div>
                            </div>

                            {/* User Information Section */}
                            <div style="
                                background: var(--color-bg-card); 
                                border-radius: 12px; 
                                padding: 24px; 
                                box-shadow: 0 2px 8px var(--color-shadow-sm);
                                border: 1px solid var(--color-border-primary);
                                transition: all 0.3s ease;
                            ">
                                <h3 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: var(--color-text-primary); transition: color 0.3s ease;">
                                    User Information
                                </h3>
                                <div style="display: flex; flex-direction: column; gap: 16px;">
                                    <div class="form-group">
                                        <label for="user_name" class="form-label">User Name (short name for your account)</label>
                                        <div class="input-container">
                                            <svg class="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                                <path d="M20 21V19C20 17.9391 19.5786 16.9217 18.8284 16.1716C18.0783 15.4214 17.0609 15 16 15H8C6.93913 15 5.92172 15.4214 5.17157 16.1716C4.42143 16.9217 4 17.9391 4 19V21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                                <circle cx="12" cy="7" r="4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                            </svg>
                                            <input 
                                                id="user_name" 
                                                type="text" 
                                                value={user_name()} 
                                                onInput={(e) => setUserName((e.target as HTMLInputElement).value)} 
                                                placeholder="Enter your username"
                                                class="form-input"
                                            />
                                        </div>
                                    </div>

                                    <div class="form-row" style="margin-bottom: 8px;">
                                        <div class="form-group form-group-half">
                                            <label for="first_name" class="form-label">First Name</label>
                                            <div class="input-container">
                                                <svg class="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                                    <path d="M20 21V19C20 17.9391 19.5786 16.9217 18.8284 16.1716C18.0783 15.4214 17.0609 15 16 15H8C6.93913 15 5.92172 15.4214 5.17157 16.1716C4.42143 16.9217 4 17.9391 4 19V21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                                    <circle cx="12" cy="7" r="4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                                </svg>
                                                <input 
                                                    id="first_name" 
                                                    type="text" 
                                                    value={first_name()} 
                                                    onInput={(e) => setFirstName((e.target as HTMLInputElement).value)} 
                                                    placeholder="First name"
                                                    class="form-input"
                                                />
                                            </div>
                                        </div>
                                        <div class="form-group form-group-half">
                                            <label for="last_name" class="form-label">Last Name</label>
                                            <div class="input-container">
                                                <svg class="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                                    <path d="M20 21V19C20 17.9391 19.5786 16.9217 18.8284 16.1716C18.0783 15.4214 17.0609 15 16 15H8C6.93913 15 5.92172 15.4214 5.17157 16.1716C4.42143 16.9217 4 17.9391 4 19V21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                                    <circle cx="12" cy="7" r="4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                                </svg>
                                                <input 
                                                    id="last_name" 
                                                    type="text" 
                                                    value={last_name()} 
                                                    onInput={(e) => setLastName((e.target as HTMLInputElement).value)} 
                                                    placeholder="Last name"
                                                    class="form-input"
                                                />
                                            </div>
                                        </div>
                                    </div>

                                    <div class="form-group">
                                        <label for="email" class="form-label">Email Address</label>
                                        <div class="input-container">
                                            <svg class="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                                <path d="M4 4H20C21.1 4 22 4.9 22 6V18C22 19.1 21.1 20 20 20H4C2.9 20 2 19.1 2 18V6C2 4.9 2.9 4 4 4Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                                <polyline points="22,6 12,13 2,6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                            </svg>
                                            <input 
                                                id="email" 
                                                type="email" 
                                                value={email()} 
                                                onInput={(e) => setEmail((e.target as HTMLInputElement).value)} 
                                                placeholder="Enter your email"
                                                class="form-input"
                                            />
                                        </div>
                                    </div>

                                    {hasUserDataChanged() && (
                                        <div class="form-actions" style="margin-top: 16px;">
                                            <button type="button" onClick={handleUpdateProfile} class="login-button">
                                                <span class="button-text">Save</span>
                                                <svg class="button-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                                    <path d="M20 6L9 17L4 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                                </svg>
                                            </button>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Invoice Information Section */}
                            {SHOW_SUBSCRIPTION_SECTIONS && (() => {
                                const subPlan = subscription();
                                const planValue = typeof subPlan === 'string' ? subPlan : subPlan?.plan;
                                const isPaid = ['standard', 'pro', 'standard_plus', 'pro_plus', 'enterprise'].includes(planValue);
                                return isPaid;
                            })() && (
                                <div style="
                                    background: var(--color-bg-card); 
                                    border-radius: 12px; 
                                    padding: 24px; 
                                    box-shadow: 0 2px 8px var(--color-shadow-sm);
                                    border: 1px solid var(--color-border-primary);
                                    transition: all 0.3s ease;
                                ">
                                    <h3 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: var(--color-text-primary); transition: color 0.3s ease;">
                                        Invoice Information
                                    </h3>
                                    <p class="form-help-text" style="margin-bottom: 16px;">Required for paid subscriptions. Saved privately in your user tags.</p>
                                    <div style="display: flex; flex-direction: column; gap: 16px;">
                                        <div class="form-group">
                                            <label class="form-label">Street Address</label>
                                            <input id="invoice_street" type="text" class="form-input" placeholder="Street, number" value={invoiceStreet()} onInput={(e) => setInvoiceStreet((e.target as HTMLInputElement).value)} />
                                        </div>
                                        <div class="form-row">
                                            <div class="form-group form-group-half">
                                                <label class="form-label">City</label>
                                                <input id="invoice_city" type="text" class="form-input" placeholder="City" value={invoiceCity()} onInput={(e) => setInvoiceCity((e.target as HTMLInputElement).value)} />
                                            </div>
                                            <div class="form-group form-group-half">
                                                <label class="form-label">Postal Code</label>
                                                <input id="invoice_postal" type="text" class="form-input" placeholder="Postal code" value={invoicePostal()} onInput={(e) => setInvoicePostal((e.target as HTMLInputElement).value)} />
                                            </div>
                                        </div>
                                        <div class="form-row">
                                            <div class="form-group form-group-half">
                                                <label class="form-label">Country</label>
                                                <input id="invoice_country" type="text" class="form-input" placeholder="Country" value={invoiceCountry()} onInput={(e) => setInvoiceCountry((e.target as HTMLInputElement).value)} />
                                            </div>
                                            <div class="form-group form-group-half">
                                                <label class="form-label">Tax ID (optional)</label>
                                                <input id="invoice_taxid" type="text" class="form-input" placeholder="VAT/Tax ID" value={invoiceTaxId()} onInput={(e) => setInvoiceTaxId((e.target as HTMLInputElement).value)} />
                                            </div>
                                        </div>
                                    </div>
                                    
                                    {hasInvoiceDataChanged() && (
                                        <div class="form-actions" style="margin-top: 16px;">
                                            <button type="button" onClick={handleUpdateProfile} class="login-button">
                                                <span class="button-text">Save Invoice Info</span>
                                                <svg class="button-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                                    <path d="M20 6L9 17L4 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                                </svg>
                                            </button>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* API Token Section */}
                            {(() => {
                                const subPlan = subscription();
                                const planValue = typeof subPlan === 'string' ? subPlan : subPlan?.plan;
                                return ["api", "enterprise", "pro", "standard_plus", "pro_plus"].includes(planValue);
                            })() && (
                                <div style="
                                    background: var(--color-bg-card); 
                                    border-radius: 12px; 
                                    padding: 24px; 
                                    box-shadow: 0 2px 8px var(--color-shadow-sm);
                                    border: 1px solid var(--color-border-primary);
                                    transition: all 0.3s ease;
                                ">
                                    <h3 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: var(--color-text-primary); transition: color 0.3s ease;">
                                        API Access
                                    </h3>
                                    <div class="form-group">
                                        <label for="api_key" class="form-label">Personal API Token</label>
                                        <div class="input-container" style="position: relative;">
                                            <svg class="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                                <path d="M21 2L2 13L8 14L10 22L21 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                                <path d="M12 2L13 8L19 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                            </svg>
                                            <input 
                                                id="api_key" 
                                                type="text" 
                                                value={apiKey() ? (showToken() ? apiKey() : `${apiKey().slice(0,4)}••••••••••••••••••••••••••••••${apiKey().slice(-4)}`) : ''} 
                                                readOnly 
                                                class="form-input"
                                                style="background-color: var(--color-bg-tertiary); padding-right: 96px;"
                                                placeholder={!apiKey() ? 'Create new key' : 'Token Available'}
                                            />
                                            <div style="position:absolute; right: 8px; top: 6px; display:flex; gap:6px;">
                                                {apiKey() && (
                                                    <div style="display:flex; gap:6px; background:var(--color-bg-secondary); border:1px solid var(--color-border-primary); padding:4px; border-radius:10px; align-items:center;">
                                                        <button 
                                                            type="button"
                                                            onClick={() => setShowToken(!showToken())}
                                                            title={showToken() ? 'Hide token' : 'Reveal token'}
                                                            style="display:flex; align-items:center; gap:6px; padding:6px 10px; border-radius:8px; border:1px solid var(--color-border-secondary); background: var(--color-bg-card); color:var(--color-text-primary); font-size:12px; cursor:pointer;"
                                                        >
                                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                                                <path d="M1 12C3.5 7 7.5 4 12 4C16.5 4 20.5 7 23 12C20.5 17 16.5 20 12 20C7.5 20 3.5 17 1 12Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                                                                <circle cx="12" cy="12" r="3.5" stroke="currentColor" stroke-width="1.5"/>
                                                            </svg>
                                                            {showToken() ? 'Hide' : 'Reveal'}
                                                        </button>
                                                        <button 
                                                            type="button"
                                                            onClick={copyToClipboard}
                                                            title="Copy to clipboard"
                                                            style="display:flex; align-items:center; gap:6px; padding:6px 10px; border-radius:8px; border:1px solid var(--color-border-secondary); background: var(--color-bg-card); color:var(--color-text-primary); font-size:12px; cursor:pointer;"
                                                        >
                                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                                                <rect x="9" y="9" width="11" height="13" rx="2" stroke="currentColor" stroke-width="1.5"/>
                                                                <rect x="4" y="4" width="11" height="13" rx="2" stroke="currentColor" stroke-width="1.5"/>
                                                            </svg>
                                                            Copy
                                                        </button>
                                                    </div>
                                                )}
                                                <button 
                                                    type="button"
                                                    onClick={createPersonalToken}
                                                    title="Create new token"
                                                    style="display:flex; align-items:center; gap:6px; padding:6px 10px; border-radius:8px; border:1px solid #10b981; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color:white; font-size:12px; cursor:pointer;"
                                                >
                                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                                        <path d="M12 5V19M5 12H19" stroke="white" stroke-width="1.8" stroke-linecap="round"/>
                                                    </svg>
                                                    New
                                                </button>
                                            </div>
                                        </div>
                                        {copyStatus() && (
                                            <p class="form-help-text" style="color: #10b981;">{copyStatus()}</p>
                                        )}
                                        {!apiKey() && (
                                            <p class="form-help-text">Click "New" to create a new API token. Tokens are only shown once at creation.</p>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Right column: Subscription + Additional Options stacked */}
                        <Show when={SHOW_SUBSCRIPTION_SECTIONS}>
                        <div class="right-column">
                        {/* Subscription Level Selection */}
                        <div style="
                            background: var(--color-bg-card); 
                            border-radius: 12px; 
                            padding: 24px; 
                            box-shadow: 0 2px 8px var(--color-shadow-sm);
                            border: 1px solid var(--color-border-primary);
                            height: fit-content;
                            transition: all 0.3s ease;
                        ">
                            <div class="form-group">
                                <label class="form-label" style="font-size: 18px; font-weight: 600; margin-bottom: 16px;">Choose Your Subscription Level</label>
                                <div style="display: grid; grid-template-columns: 1fr; gap: 12px; margin-bottom: 20px; width: 100%; max-width: 100%;">
                                    {subscriptionLevels.map((level) => {
                                        const currentPlan = subscription();
                                        const planValue = typeof currentPlan === 'string' ? currentPlan : currentPlan?.plan;
                                        const isCurrent = planValue === level.id;
                                        const isSelectable = level.selectable !== false;
                                        
                                        return (
                                            <button
                                                type="button"
                                                class="subscription-card"
                                                onClick={() => handleSubscriptionChange(level.id)}
                                                disabled={!isSelectable}
                                                style={`
                                                    background: ${isCurrent ? (level.background || level.color) : 'var(--color-bg-card)'};
                                                    border: 2px solid ${isCurrent ? 'transparent' : level.color};
                                                    border-radius: 12px;
                                                    padding: 16px;
                                                    text-align: left;
                                                    cursor: ${isSelectable ? 'pointer' : 'default'};
                                                    transition: all 0.3s ease;
                                                    box-shadow: ${isCurrent ? '0 8px 25px rgba(0,0,0,0.2)' : `0 4px 15px ${level.color.replace('linear-gradient(135deg, ', '').replace(' 0%, ', '40, ').replace(' 100%)', '20)')}`};
                                                    position: relative;
                                                    display: flex;
                                                    align-items: center;
                                                    gap: 16px;
                                                    overflow: hidden;
                                                    width: 100%;
                                                    max-width: 100%;
                                                    box-sizing: border-box;
                                                    opacity: ${isSelectable ? '1' : '0.7'};
                                                `}
                                                onMouseEnter={(e: MouseEvent) => {
                                                    if (!isCurrent && isSelectable) {
                                                        const target = e.target as HTMLElement;
                                                        if (target && target.style) {
                                                            target.style.transform = 'translateY(-4px) scale(1.02)';
                                                            target.style.background = level.hoverColor;
                                                            target.style.boxShadow = `0 12px 30px ${level.color.replace('linear-gradient(135deg, ', '').replace(' 0%, ', '40, ').replace(' 100%)', '30)')}`;
                                                        }
                                                    }
                                                }}
                                                onMouseLeave={(e: MouseEvent) => {
                                                    if (!isCurrent && isSelectable) {
                                                        const target = e.target as HTMLElement;
                                                        if (target && target.style) {
                                                            target.style.transform = 'translateY(0) scale(1)';
                                                            target.style.background = level.background || 'var(--color-bg-card)';
                                                            target.style.boxShadow = `0 4px 15px ${level.color.replace('linear-gradient(135deg, ', '').replace(' 0%, ', '40, ').replace(' 100%)', '20)')}`;
                                                        }
                                                    }
                                                }}
                                            >
                                                {/* Current Badge */}
                                                {isCurrent && (
                                                    <div style={`position: absolute; top: 8px; right: 8px; background: rgba(255,255,255,0.2); color: ${level.textColor || 'white'}; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600;`}>
                                                        CURRENT
                                                    </div>
                                                )}
                                                
                                                {/* Icon */}
                                                <div style={`
                                                    width: 48px; 
                                                    height: 48px; 
                                                    background: ${isCurrent ? 'rgba(255,255,255,0.25)' : level.color}; 
                                                    border-radius: 12px; 
                                                    display: flex; 
                                                    align-items: center; 
                                                    justify-content: center;
                                                    flex-shrink: 0;
                                                    box-shadow: ${isCurrent ? '0 4px 12px rgba(0,0,0,0.2)' : '0 4px 12px rgba(0,0,0,0.15)'};
                                                `}>
                                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                                        <path d={level.icon} stroke={isCurrent ? (level.textColor || (level.background ? level.textColor : 'white')) : 'white'} stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                                                    </svg>
                                                </div>
                                                
                                                {/* Content */}
                                                <div class="subscription-content" style="flex: 1; min-width: 0;">
                                                    <h3 style={`
                                                        color: ${isCurrent ? (level.textColor || (level.background ? level.textColor : 'white')) : 'var(--color-text-primary)'}; 
                                                        font-size: 16px; 
                                                        font-weight: 700; 
                                                        margin: 0 0 4px 0;
                                                    `}>
                                                        {level.name}
                                                    </h3>
                                                {level.price && (
                                                    <div style={`
                                                        color: ${isCurrent ? (level.textColor || (level.background ? level.textColor : 'white')) : '#0ea5e9'};
                                                        font-size: 12px;
                                                        font-weight: 700;
                                                        margin: 0 0 8px 0;
                                                    `}>
                                                        {level.price}
                                                    </div>
                                                )}
                                                    <p style={`
                                                        color: ${isCurrent ? (level.textColor || (level.background ? level.textColor : 'rgba(255,255,255,0.8)')) : 'var(--color-text-secondary)'}; 
                                                        font-size: 12px; 
                                                        margin: 0 0 8px 0;
                                                    `}>
                                                        {level.description}
                                                    </p>
                                                    
                                                    {/* Features */}
                                                    <div style="display: flex; flex-wrap: wrap; gap: 4px;">
                                                        {level.features.slice(0, 4).map((feature, index) => (
                                                            <span style={`
                                                                background: ${isCurrent ? (level.background ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.2)') : 'var(--color-bg-tertiary)'};
                                                                color: ${isCurrent ? (level.textColor || (level.background ? level.textColor : 'white')) : 'var(--color-text-secondary)'};
                                                                padding: 2px 6px;
                                                                border-radius: 4px;
                                                                font-size: 10px;
                                                                font-weight: 500;
                                                            `}>
                                                                {feature}
                                                            </span>
                                                        ))}
                                                        {level.features.length > 4 && (
                                                            <span 
                                                                style={`
                                                                    background: ${isCurrent ? (level.background ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.2)') : 'var(--color-bg-tertiary)'};
                                                                    color: ${isCurrent ? (level.textColor || (level.background ? level.textColor : 'white')) : 'var(--color-text-secondary)'};
                                                                    padding: 2px 6px;
                                                                    border-radius: 4px;
                                                                    font-size: 10px;
                                                                    font-weight: 500;
                                                                    cursor: help;
                                                                `}
                                                                title={level.features.slice(4).join(', ')}
                                                            >
                                                                +{level.features.length - 4} more
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                                
                                                {/* Action Button */}
                                                <div style="flex-shrink: 0;">
                                                    <div style={`
                                                        background: ${isCurrent ? 'rgba(255,255,255,0.25)' : level.color};
                                                        color: ${isCurrent ? (level.textColor || 'white') : 'white'};
                                                        padding: 8px 16px;
                                                        border-radius: 8px;
                                                        font-size: 12px;
                                                        font-weight: 700;
                                                        text-align: center;
                                                        border: none;
                                                        white-space: nowrap;
                                                        box-shadow: ${isCurrent ? '0 2px 8px rgba(0,0,0,0.2)' : '0 2px 8px rgba(0,0,0,0.15)'};
                                                        text-transform: uppercase;
                                                        letter-spacing: 0.5px;
                                                    `}>
                                                        {isCurrent ? 'Current' : (level.id === 'enterprise' ? 'Contact Us' : (isSelectable ? 'Select' : 'Default'))}
                                                    </div>
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>

                        {/* Additional Options for Selected Subscription */}
                        <div style="
                            background: var(--color-bg-card); 
                            border-radius: 12px; 
                            padding: 24px; 
                            box-shadow: 0 2px 8px var(--color-shadow-sm);
                            border: 1px solid var(--color-border-primary);
                            transition: all 0.3s ease;
                        ">
                            <h3 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: var(--color-text-primary); transition: color 0.3s ease;">
                                Additional Options
                            </h3>
                            
                            {/* Video Upload Option for Standard */}
                            {(() => {
                                const subPlan = subscription();
                                const planValue = typeof subPlan === 'string' ? subPlan : subPlan?.plan;
                                const isStandard = planValue === 'standard';
                                
                                if (!isStandard) return null;
                                
                                return (
                                    <div style="
                                        background: var(--color-bg-secondary); 
                                        border-radius: 8px; 
                                        padding: 16px; 
                                        margin-bottom: 12px;
                                        border: 1px solid var(--color-border-primary);
                                    ">
                                        <div style="display: flex; align-items: center; justify-content: space-between;">
                                            <div>
                                                <h4 style="margin: 0 0 4px 0; font-size: 16px; font-weight: 600; color: var(--color-text-primary);">
                                                    Video Upload & Replay
                                                </h4>
                                                <p style="margin: 0; color: var(--color-text-secondary); font-size: 14px;">
                                                    Upload sailing videos and replay them synced with your data
                                                </p>
                                                <div style="margin-top: 6px; font-size: 12px; font-weight: 700; color: #0ea5e9;">
                                                    €10 / video hour
                                                </div>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    // For now, just show a message - can be implemented later
                                                    alert('Video upload feature coming soon! This will allow you to upload sailing videos and replay them synchronized with your data.');
                                                }}
                                                style="
                                                    background: linear-gradient(135deg, #10b981 0%, #059669 100%);
                                                    color: white;
                                                    border: none;
                                                    border-radius: 6px;
                                                    padding: 8px 16px;
                                                    font-size: 12px;
                                                    font-weight: 600;
                                                    cursor: pointer;
                                                    display: flex;
                                                    align-items: center;
                                                    gap: 6px;
                                                    box-shadow: 0 2px 8px rgba(16, 185, 129, 0.3);
                                                    transition: all 0.2s ease;
                                                "
                                                onMouseEnter={(e: MouseEvent) => {
                                                    const target = e.target as HTMLElement;
                                                    if (target && target.style) {
                                                        target.style.transform = 'translateY(-1px)';
                                                        target.style.boxShadow = '0 4px 12px rgba(16, 185, 129, 0.4)';
                                                    }
                                                }}
                                                onMouseLeave={(e: MouseEvent) => {
                                                    const target = e.target as HTMLElement;
                                                    if (target && target.style) {
                                                        target.style.transform = 'translateY(0)';
                                                        target.style.boxShadow = '0 2px 8px rgba(16, 185, 129, 0.3)';
                                                    }
                                                }}
                                            >
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                                    <path d="M23 7l-7 5 7 5V7z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2" stroke="currentColor" stroke-width="2"/>
                                                </svg>
                                                Add Video
                                            </button>
                                        </div>
                                    </div>
                                );
                            })()}

                            {/* Support+ Option */}
                            {(() => {
                                const subPlan = subscription();
                                const planValue = typeof subPlan === 'string' ? subPlan : subPlan?.plan;
                                const canAddSupportPlus = ['standard', 'pro'].includes(planValue);
                                
                                if (!canAddSupportPlus) return null;
                                
                                return (
                                    <div style="
                                        background: var(--color-bg-secondary); 
                                        border-radius: 8px; 
                                        padding: 16px; 
                                        border: 1px solid var(--color-border-primary);
                                    ">
                                        <div style="display: flex; align-items: center; justify-content: space-between;">
                                            <div>
                                                <h4 style="margin: 0 0 4px 0; font-size: 16px; font-weight: 600; color: var(--color-text-primary);">
                                                    Add Support+ Option
                                                </h4>
                                                <p style="margin: 0; color: var(--color-text-secondary); font-size: 12px; padding-top: 4px">
                                                    We'll do the heavy lifting! Includes personalized & expert feedback.
                                                </p>
                                                <div style="margin-top: 6px; font-size: 12px; font-weight: 700; color: #8b5cf6; padding-top: 4px">
                                                    $100 / boat / day
                                                </div>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => handleSubscriptionChange(`${planValue}_plus`)}
                                                style="
                                                    background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
                                                    color: white;
                                                    border: none;
                                                    border-radius: 6px;
                                                    padding: 8px 16px;
                                                    font-size: 12px;
                                                    font-weight: 600;
                                                    cursor: pointer;
                                                    display: flex;
                                                    align-items: center;
                                                    gap: 6px;
                                                    box-shadow: 0 2px 8px rgba(139, 92, 246, 0.3);
                                                    transition: all 0.2s ease;
                                                "
                                                onMouseEnter={(e: MouseEvent) => {
                                                    const target = e.target as HTMLElement;
                                                    if (target && target.style) {
                                                        target.style.transform = 'translateY(-1px)';
                                                        target.style.boxShadow = '0 4px 12px rgba(139, 92, 246, 0.4)';
                                                    }
                                                }}
                                                onMouseLeave={(e: MouseEvent) => {
                                                    const target = e.target as HTMLElement;
                                                    if (target && target.style) {
                                                        target.style.transform = 'translateY(0)';
                                                        target.style.boxShadow = '0 2px 8px rgba(139, 92, 246, 0.3)';
                                                    }
                                                }}
                                            >
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                                    <path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                                    <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                                                </svg>
                                                Add Support+
                                            </button>
                                        </div>
                                    </div>
                                );
                            })()}

                            {/* Show message when no additional options available */}
                            {(() => {
                                const subPlan = subscription();
                                const planValue = typeof subPlan === 'string' ? subPlan : subPlan?.plan;
                                const hasOptions = planValue === 'standard' || ['standard', 'pro'].includes(planValue);
                                
                                if (hasOptions) return null;
                                
                                return (
                                    <div style="
                                        background: var(--color-bg-secondary); 
                                        border-radius: 8px; 
                                        padding: 16px; 
                                        border: 1px solid var(--color-border-primary);
                                        text-align: center;
                                    ">
                                        <p style="margin: 0; color: var(--color-text-secondary); font-size: 14px;">
                                            No additional options available for your current subscription.
                                        </p>
                                    </div>
                                );
                            })()}
                        </div>

                        </div>
                        </Show>

                    </div>
                    </div>
                </div>
                <BackButton />
            </Show>
        </div>
        </>
    );
}
