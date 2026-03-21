import { createSignal, Accessor, Setter, createRoot } from "solid-js";

// Type definitions
export interface User {
  id: number;
  username: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role?: string;
  permissions?: string[];
  [key: string]: any;
}

export interface Subscription {
  id?: number;
  plan?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
  features?: string[];
  [key: string]: any;
}

// Union type to handle both string and object subscription types
export type SubscriptionData = string | Subscription | null;

// Initialize signals inside createRoot so computations are disposed with the app root
let isLoggedInAccessor: Accessor<boolean>;
let setIsLoggedInSetter: Setter<boolean>;
let userAccessor: Accessor<User | null>;
let setUserSetter: Setter<User | null>;
let subscriptionAccessor: Accessor<SubscriptionData>;
let setSubscriptionSetter: Setter<SubscriptionData>;
let isAcceptedAccessor: Accessor<boolean>;
let setIsAcceptedSetter: Setter<boolean>;
let isCookiePolicyAccessor: Accessor<boolean>;
let setCookiePolicySetter: Setter<boolean>;

createRoot(() => {
  const [isLoggedInSig, setIsLoggedInSig] = createSignal(false);
  const [userSig, setUserSig] = createSignal<User | null>(null);
  const [subscriptionSig, setSubscriptionSig] = createSignal<SubscriptionData>(null);
  const [isAcceptedSig, setIsAcceptedSig] = createSignal(false);
  const [isCookiePolicySig, setCookiePolicySig] = createSignal(false);
  isLoggedInAccessor = isLoggedInSig;
  setIsLoggedInSetter = setIsLoggedInSig;
  userAccessor = userSig;
  setUserSetter = setUserSig;
  subscriptionAccessor = subscriptionSig;
  setSubscriptionSetter = setSubscriptionSig;
  isAcceptedAccessor = isAcceptedSig;
  setIsAcceptedSetter = setIsAcceptedSig;
  isCookiePolicyAccessor = isCookiePolicySig;
  setCookiePolicySetter = setCookiePolicySig;
});

export const isLoggedIn = (): boolean => isLoggedInAccessor!();
export const setIsLoggedIn = (value: boolean) => setIsLoggedInSetter!(value);
export const user = (): User | null => userAccessor!();
export const setUser = (value: User | null) => setUserSetter!(value);
export const subscription = (): SubscriptionData => subscriptionAccessor!();
export const setSubscription = (value: SubscriptionData) => setSubscriptionSetter!(value);
export const isAccepted = (): boolean => isAcceptedAccessor!();
export const setIsAccepted = (value: boolean) => setIsAcceptedSetter!(value);
export const isCookiePolicy = (): boolean => isCookiePolicyAccessor!();
export const setCookiePolicy = (value: boolean) => setCookiePolicySetter!(value); 

