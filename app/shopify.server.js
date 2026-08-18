import '@shopify/shopify-app-react-router/adapters/node';
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  shopifyApp,
} from '@shopify/shopify-app-react-router/server';
import { PrismaSessionStorage } from '@shopify/shopify-app-session-storage-prisma';
import prisma from './db.server';
import { PLANS } from './lib/plans';

/** Free needs no Shopify subscription — it is the local default, so it is
 *  deliberately absent from this map. Only paid plans are declared here. */
export const TRIAL_DAYS = 14;

/** Public app origin, used to build absolute return URLs for billing. */
export const APP_URL = process.env.SHOPIFY_APP_URL || '';
const BILLING_CURRENCY = 'USD';

const recurringPlan = (plan) => ({
  lineItems: [
    {
      amount: plan.price,
      currencyCode: BILLING_CURRENCY,
      interval: BillingInterval.Every30Days,
    },
  ],
  trialDays: TRIAL_DAYS,
});

export const BILLING_PLANS = {
  [PLANS.standard.key]: recurringPlan(PLANS.standard),
  [PLANS.enterprise.key]: recurringPlan(PLANS.enterprise),
};

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || '',
  apiVersion: ApiVersion.July26,
  scopes: process.env.SCOPES?.split(','),
  appUrl: process.env.SHOPIFY_APP_URL || '',
  authPathPrefix: '/auth',
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  billing: BILLING_PLANS,
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
