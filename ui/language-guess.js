// A small offline language guess for KaPosts' Translate link, used only where the browser has no
// LanguageDetector (Safari on iPhone, Chrome on Android, Firefox) - without one, Translate was never
// offered on a phone. iOS asks NLLanguageRecognizer; this asks two cheaper questions:
//
// 1. The script. Cyrillic, Arabic, Hebrew, Greek, Devanagari, Hangul, kana and Han text names its
//    language (or a narrow family) by itself.
// 2. For Latin text, the commonest short words of each Latin-script language the translation
//    service serves. The best language wins when it has at least two hits and clearly beats the
//    runner-up.
//
// When it cannot tell but the text plainly is NOT in the reader's language (enough words, none of
// the reader's common ones, some of another's), it answers OTHER: worth offering, and the
// service's answer settles it - a post that comes back already in the reader's language loses its
// link for good.

export const OTHER_LANGUAGE = "?";

const STOPWORDS = {
  en: "the and is are was were you your this that with for not have has what will just from they but all can about there their would been our out more when one how get like know to of in on it we my me so be do at an or if up now new here who why yes good time day see make go going let us its it's i'm don't",
  es: "el la los las que de del por para con una uno es son está están pero como más muy hola gracias también porque cuando todo nada este esta yo tú nosotros hay",
  pt: "o a os as que de do da dos das por para com uma um é são está estão mas como mais muito obrigado também porque quando tudo nada este esta eu você nós não",
  fr: "le la les des que de du pour avec une un est sont mais comme plus très merci aussi parce quand tout rien ce cette je tu nous vous pas il elle",
  de: "der die das und ist sind nicht mit für ein eine aber wie mehr sehr danke auch weil wenn alles nichts dieser diese ich du wir ihr sie es auf",
  it: "il lo la gli le che di del della per con una uno è sono ma come più molto grazie anche perché quando tutto niente questo questa io tu noi voi non",
  nl: "de het een en is zijn niet met voor maar als meer heel dank ook omdat wanneer alles niets deze dit ik jij wij jullie zij op van",
  pl: "i w na jest są nie z do że to się jak ale co tak dla od po jestem dziękuję bardzo wszystko ten ta ja ty my wy oni",
  ro: "și în pe este sunt nu cu de la că pentru dar ca mai foarte mulțumesc tot nimic acest această eu tu noi voi ei",
  sv: "och är inte med för en ett men som mer mycket tack också eftersom när allt inget den det jag du vi ni de på av",
  tr: "ve bir bu da de için ile ama gibi daha çok teşekkürler ne var yok ben sen biz siz onlar değil mi çünkü",
  cs: "a je jsou není s pro ale jako více velmi děkuji také protože když všechno nic tento tato já ty my vy oni na v",
  id: "dan yang di ke dari ini itu dengan untuk tidak ada saya kamu kami mereka tapi juga karena kalau sudah akan bisa terima kasih",
  vi: "và là của có không với cho một những các này đó tôi bạn chúng được người rất cảm ơn cũng vì khi",
};
const WORD_SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([code, words]) => [code, new Set(words.split(" "))]));

function scriptGuess(text) {
  const letters = String(text || "").match(/\p{L}/gu) || [];
  if (!letters.length) return "";
  const count = (re) => letters.filter((ch) => re.test(ch)).length;
  const half = letters.length / 2;
  if (count(/\p{Script=Latin}/u) >= half) return "";
  const kana = count(/[\p{Script=Hiragana}\p{Script=Katakana}]/u);
  if (kana) return "ja";
  if (count(/\p{Script=Hangul}/u) >= half) return "ko";
  if (count(/\p{Script=Han}/u) >= half) return "zh";
  if (count(/\p{Script=Cyrillic}/u) >= half) return /[іїєґ]/iu.test(text) ? "uk" : "ru";
  if (count(/\p{Script=Arabic}/u) >= half) return /[پچژگک]/u.test(text) || /ی/u.test(text) ? "fa" : "ar";
  if (count(/\p{Script=Hebrew}/u) >= half) return "he";
  if (count(/\p{Script=Greek}/u) >= half) return "el";
  if (count(/\p{Script=Devanagari}/u) >= half) return "hi";
  return OTHER_LANGUAGE;
}

/**
 * A language code, OTHER_LANGUAGE ("not the reader's, unknown which") or "" (could not tell).
 * `reader`: the reader's language code (only used for OTHER_LANGUAGE).
 */
export function guessLanguage(text, reader = "en") {
  const clean = String(text || "").replace(/https?:\/\/\S+/g, " ").replace(/@[\w.-]+/g, " ");
  const byScript = scriptGuess(clean);
  if (byScript) return byScript;
  const words = (clean.toLowerCase().match(/[\p{L}']+/gu) || []).map((word) => word.replace(/^'+|'+$/g, "")).filter(Boolean);
  if (words.length < 2) return "";
  const scores = Object.entries(WORD_SETS)
    .map(([code, set]) => [code, words.reduce((sum, word) => sum + (set.has(word) ? 1 : 0), 0)])
    .sort((a, b) => b[1] - a[1]);
  const [best, second] = scores;
  if (best[1] >= 2 && best[1] >= second[1] * 1.5 + 0.5) return best[0];
  // Enough text that the reader's own commonest words would show, not one of them does, and
  // another language's do. (No common words at all is a headline or a list of names: unknown.)
  const readerSet = WORD_SETS[reader];
  const readerHits = scores.find(([code]) => code === reader)?.[1] || 0;
  const otherHits = scores.find(([code]) => code !== reader)?.[1] || 0;
  if (readerSet && words.length >= 6 && readerHits === 0 && otherHits >= 1) return OTHER_LANGUAGE;
  return "";
}
