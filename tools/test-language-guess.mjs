// The offline guess behind KaPosts' Translate link on browsers without LanguageDetector.
import assert from "node:assert/strict";
import { guessLanguage, OTHER_LANGUAGE } from "../ui/language-guess.js";

const cases = [
  ["Hola amigos, como estan todos hoy? Gracias por todo", "es"],
  ["Bom dia, obrigado pela ajuda, você é muito legal", "pt"],
  ["Merci beaucoup pour votre aide, je suis très content", "fr"],
  ["Ich bin nicht sicher, aber das ist sehr gut und wir sind hier", "de"],
  ["Grazie mille, questo è molto bello e non vedo l'ora", "it"],
  ["Just bought more KAS and the network is fast, what do you think about this", "en"],
  ["Привет всем, как дела у вас сегодня?", "ru"],
  ["Привіт, як справи? Їжак і ґанок", "uk"],
  ["こんにちは、元気ですか", "ja"],
  ["你好，今天天气很好", "zh"],
  ["안녕하세요 반갑습니다", "ko"],
  ["مرحبا بكم جميعا", "ar"],
  ["שלום לכולם", "he"],
  ["Γεια σας φίλοι", "el"],
  ["नमस्ते दोस्तों", "hi"],
];
for (const [text, want] of cases) assert.equal(guessLanguage(text, "en"), want, text);
// Too little to tell.
assert.equal(guessLanguage("gm", "en"), "");
assert.equal(guessLanguage("Kaspa 🚀🚀", "en"), "");
// Six words, none of the reader's: offered, the service decides.
assert.equal(guessLanguage("Selamat pagi semua, ini kawan baik sekali", "en"), OTHER_LANGUAGE);
// Short English headlines are not offered.
assert.notEqual(guessLanguage("Kaspa network hits record TPS today", "en"), OTHER_LANGUAGE);
assert.notEqual(guessLanguage("Kaspa network hits a new record today", "en"), OTHER_LANGUAGE);
// Links and mentions are not words.
assert.equal(guessLanguage("https://example.com/the/and/is/are @the", "en"), "");
console.log("language guess: ok");
