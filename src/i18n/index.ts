import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en/common.json';
import fr from './locales/fr/common.json';

/** French is the default AND the fallback language. All strings live in locales/<lng>/common.json. */
export const LANGS = ['fr', 'en'] as const;
export function initI18n(lng: 'fr' | 'en' = 'fr') {
  if (!i18n.isInitialized) {
    i18n.use(initReactI18next).init({
      resources: { fr: { common: fr }, en: { common: en } },
      lng, fallbackLng: 'fr', defaultNS: 'common', ns: ['common'],
      interpolation: { escapeValue: false },
      returnNull: false,
    });
  } else i18n.changeLanguage(lng);
  return i18n;
}
export const translate = (lng: 'fr' | 'en', key: string, params: Record<string, any> = {}) => i18n.t(key, { lng, ...params }) as string;
export default i18n;
