// PAUSE — transizione card Home → lettura. La copertina non cambia schermata:
// resta ferma e si allarga fino alla cornice della presentazione del lettore;
// titolo e pillola dei badge, già in fondo alla card nello stesso ordine della
// presentazione (titolo sopra, dati sotto), scivolano di poco fin sotto la
// copertina e la pillola diventa la griglia info; introduzione e tasti compaiono al loro
// posto. Finita l'animazione (livello fermo, già identico alla presentazione)
// si apre il lettore sotto senza animazione nativa e, appena è disegnato,
// questo livello si dissolve sopra di lui: nessun lavoro pesante mentre
// qualcosa si muove. Il ritorno (direction="close") è lo stesso percorso,
// all'indietro, verso la cornice reale della card misurata sulla Home.
// Solo trasformazioni e opacità sugli elementi in movimento (niente layout a
// ogni frame): fluido anche su Android e sul web.
import { useEffect, useRef, useState } from "react";
import { InteractionManager, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import Ionicons from "@react-native-vector-icons/ionicons";
import Animated, { Easing, Extrapolation, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";

import { StoryPreview } from "@/src/api";
import { makeStyles, spacing, typography, useTheme, withAlpha } from "@/src/theme";
import { StoryHero } from "./story-hero";
import { DECK_BADGES_GAP, DECK_BADGES_H } from "./deck-badges";
import { StoryInfoGrid } from "./story-info-grid";
import { HighlightedTitle } from "./highlighted-title";
import { ReaderIntro, CoverTitle, IntroRect, readerCoverFrame } from "./reader-intro";
import { ReaderAtmosphere } from "./reader-atmosphere";
import { ReaderFrame } from "./reader-frame";
import { CoverNightSkin, CoverSeam } from "./reader-cover-backdrop";
import { useMorphHost } from "./morph-host";

export type MorphRect = IntroRect;

export const MORPH_DURATION = 680;
// Curva sinusoidale simmetrica: partenza morbida e, soprattutto, arrivo ancora
// in movimento fino all'ultimo fotogramma (nell'ultimo 15% del tempo si copre
// ~5% della strada, contro <1% dell'ease-out cubico): titolo e griglia non
// "si fermano" a un passo dalla meta per poi scattarvi sopra.
export const MORPH_EASING = Easing.inOut(Easing.sin);
// Apertura: il lettore si monta sotto quando la corsa è quasi conclusa (da qui
// alla fine si copre meno del 2% della strada: eventuali fotogrammi persi nel
// montaggio sono invisibili) così, alla fine, lo scambio è immediato — nessuna
// pausa con gli elementi fermi a un pixel dalla meta.
const OPEN_COMMIT_AT = 0.86;
// Chiusura: il livello si dissolve sopra la card mentre percorre l'ultimo
// tratto — l'arrivo è una fusione con la card reale, mai uno stacco netto.
const CLOSE_FADE_MS = 150;
// Dissolvenza d'ingresso del livello quando si chiude da un capitolo (la
// schermata sotto non è la presentazione): prima si torna alla copertina, poi
// tutto rientra nella card.
const FADE_IN_MS = 240;
// Chiusura con swipe: prima la presentazione torna al suo posto (lo spostamento
// del dito si annulla), poi parte il percorso inverso — l'esatto contrario
// dell'apertura. Il rientro nella card parte quando lo scorrimento è quasi
// concluso (70%: resta meno del 3% della strada) per non sembrare due passi.
const SLIDE_BACK_MS = 220;
// Ritorno: attesa massima perché la Home, tornata sotto il livello, abbia il
// layout definitivo (es. la card "riprendi" che compare e restringe il mazzo);
// poi si misura la card reale e vi si rientra. Se la Home tace, si parte comunque.
const HOME_SETTLE_MAX_MS = 240;
// Geometria della card Home (home-story-card): bordo, padding del corpo (il
// titolo sta in fondo alla card), larghezza del tasto cuffie (44 + gap 10),
// raggio della card e della copertina. I tre dati stanno SOTTO la card
// (deck-badges), nello stesso vetro della scheda del lettore.
const CARD_BORDER = 1, CARD_PAD = 16, LISTEN_W = 54, CARD_RADIUS = 19;
const sameRect = (a: MorphRect, b: MorphRect) =>
  Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
const CLAMP = Extrapolation.CLAMP;
const noop = () => {};
const lerp = (p: number, a: number, b: number) => { "worklet"; return a + (b - a) * p; };

export function StoryMorph({ story, from: fromProp, premium, ready, onCommit, direction = "open", offsetX = 0, fadeIn = false }: {
  story: StoryPreview;
  /** Cornice della card nella Home (coordinate finestra). */
  from: MorphRect;
  premium: boolean;
  /** Apertura: storia completa in cache, il lettore si apre solo quando c'è. */
  ready?: Promise<unknown>;
  /** Apertura: apre il lettore (già identico sotto). Chiusura: torna alla Home (sotto il livello). */
  onCommit: () => void;
  /** "close": il percorso inverso, dalla presentazione del lettore alla card della Home. */
  direction?: "open" | "close";
  /** Chiusura da swipe: spostamento orizzontale della schermata al rilascio, riassorbito durante il ritorno. */
  offsetX?: number;
  /** Chiusura da un capitolo: il livello (presentazione) compare in dissolvenza prima di rientrare nella card. */
  fadeIn?: boolean;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: winW, height: windowH } = useWindowDimensions();
  // Altezza reale del livello (= area del lettore sotto): su Android la
  // finestra riportata può differire dall'area disegnata (barre di sistema);
  // usando la misura vera, la schermata finale del livello coincide al pixel
  // con l'apertura del lettore e lo scambio non produce alcun salto.
  const [layerH, setLayerH] = useState<number | null>(null);
  const winH = layerH ?? windowH;
  const host = useMorphHost();
  const closing = direction === "close";
  // Chiusura: la cornice d'arrivo è quella reale della card sulla Home, riletta
  // appena la Home è tornata sotto (può essere cambiata mentre si leggeva).
  const [from, setFrom] = useState(fromProp);
  const p = useSharedValue(closing ? 1 : 0);
  const veil = useSharedValue(closing && fadeIn ? 0 : 1);
  // Spostamento orizzontale lasciato dallo swipe: si annulla prima del rientro.
  const slideX = useSharedValue(offsetX);
  const still = useSharedValue(0);

  // Stessa geometria dell'apertura del lettore (deep-dive/[id]): copertina a
  // tutta larghezza dall'alto; si abbassa come nel lettore quando l'apertura
  // misura il testo (stesso `onFit`), così le due schermate restano identiche.
  const [reserveCap, setReserveCap] = useState<number | null>(null);
  const cover = readerCoverFrame(winW, winH, reserveCap);
  const coverTop = cover.top;
  const cardW = cover.width;
  const cardH = cover.height;
  const [sheetMeasured, setSheetMeasured] = useState(false);
  const to: MorphRect = { x: cover.left, y: coverTop, width: cardW, height: cardH };

  // Dove atterrano titolo e griglia: misurati sui segnaposto della scheda. Quando
  // la card cambia altezza la scheda si sposta senza un nuovo onLayout: la scheda
  // rimisura (prop `remeasure`) e si accettano solo le misure prese con la card
  // corrente (`cardHRef`), così le mete sono sempre quelle della geometria finale.
  type Target = MorphRect & { forCardH: number };
  const [titleTo, setTitleTo] = useState<Target | null>(null);
  const [gridTo, setGridTo] = useState<Target | null>(null);
  const cardHRef = useRef(cardH);
  cardHRef.current = cardH;
  const acceptTitle = (r: MorphRect) => { if (cardH === cardHRef.current) setTitleTo({ ...r, forCardH: cardH }); };
  const acceptGrid = (r: MorphRect) => { if (cardH === cardHRef.current) setGridTo({ ...r, forCardH: cardH }); };
  const [cardTitleH, setCardTitleH] = useState(0);
  const inset = CARD_BORDER + CARD_PAD;
  const titleW = from.width - inset * 2 - (premium ? LISTEN_W : 0);
  // Titolo sull'ultimo rigo della card; i tre dati subito sotto la card.
  const chipsFrom: MorphRect = { x: from.x, y: from.y + from.height + DECK_BADGES_GAP, width: from.width, height: DECK_BADGES_H };
  const titleRowBottom = from.y + from.height - inset;
  const titleFrom = { x: from.x + inset, y: titleRowBottom - cardTitleH };
  const cardFont = Math.min(31, Math.max(20, winW * (story.title.length > 65 ? 0.056 : 0.062)));
  // Gli elementi in movimento stanno fermi nella posizione finale e si spostano
  // solo con una traslazione: finché la meta non è misurata, la meta è la partenza.
  const titleAt = titleTo ?? titleFrom;
  const gridBox = gridTo ?? chipsFrom;
  const titleShift = { x: titleFrom.x - titleAt.x, y: titleFrom.y - titleAt.y };
  const gridShift = {
    x: chipsFrom.x + chipsFrom.width / 2 - (gridBox.x + gridBox.width / 2),
    y: chipsFrom.y + chipsFrom.height / 2 - (gridBox.y + gridBox.height / 2),
  };
  const coverShift = { x: from.x + from.width / 2 - (to.x + to.width / 2), y: from.y + from.height / 2 - (to.y + to.height / 2) };
  const coverScale = { x: from.width / to.width, y: from.height / to.height };

  const measured = sheetMeasured && reserveCap != null && titleTo?.forCardH === cardH && gridTo?.forCardH === cardH && cardTitleH > 0;
  const [animDone, setAnimDone] = useState(false);
  // La storia in cache non provoca ri-render a metà corsa (su nativo un
  // ri-render riapplica gli stili delle viste animate): si annota in un ref e
  // si sveglia il livello solo se la corsa è già finita.
  const dataReadyRef = useRef(!ready);
  const animDoneRef = useRef(false);
  const [dataWake, setDataWake] = useState(0);
  const started = useRef(false);
  const committed = useRef(false);
  useEffect(() => {
    if (!ready) return;
    const arrived = () => { dataReadyRef.current = true; if (animDoneRef.current) setDataWake((n) => n + 1); };
    ready.then(arrived, arrived);
  }, [ready]);
  // Apre il lettore sotto (una volta sola). Rete di sicurezza: se il lettore
  // non si presenta, il livello non resta a bloccare l'app.
  const { dismiss: hostDismiss } = host;
  const safetyDismiss = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitOpen = useRef(() => {});
  commitOpen.current = () => {
    if (committed.current) return;
    committed.current = true;
    onCommit();
    safetyDismiss.current = setTimeout(hostDismiss, 2500);
  };
  // Il livello se ne va: la rete di sicurezza non deve colpire un livello successivo (es. il ritorno).
  useEffect(() => () => { if (safetyDismiss.current) clearTimeout(safetyDismiss.current); }, []);
  // Apertura: parte appena si sa dove atterrano titolo e griglia. Il lettore
  // vero si monta solo quando la corsa è FINITA (e la storia è in cache): il
  // montaggio — il lavoro più pesante — non può togliere fotogrammi a nulla
  // che si muove. Nel frattempo il livello mostra già la schermata finale,
  // identica al lettore: nessuna attesa visibile, poi la dissolvenza.
  useEffect(() => {
    if (closing || !measured || started.current) return;
    started.current = true;
    const finishOpen = () => { animDoneRef.current = true; setAnimDone(true); };
    p.value = withTiming(1, { duration: MORPH_DURATION, easing: MORPH_EASING }, (done) => { if (done) runOnJS(finishOpen)(); });
    // Montaggio anticipato del lettore (solo se la storia è già in cache).
    const early = setTimeout(() => { if (dataReadyRef.current) commitOpen.current(); }, Math.round(MORPH_DURATION * OPEN_COMMIT_AT));
    return () => clearTimeout(early);
  }, [closing, measured, p]);
  useEffect(() => {
    if (closing || !animDone || !dataReadyRef.current) return;
    commitOpen.current();
  }, [closing, animDone, dataWake]);
  // Scambio solo quando il lettore sotto è disegnato e stabile (host.ready):
  // dissolvenza breve tra due schermate identiche, mai un salto.
  useEffect(() => {
    if (closing || !animDone || !host.ready) return;
    host.dismiss();
  }, [closing, animDone, host.ready, host.dismiss]);
  // Rete di sicurezza assoluta: se la geometria non arriva (layout mai stabile),
  // si passa comunque di là e il livello si toglie: mai un'app bloccata.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (started.current) return;
      started.current = true;
      committed.current = true;
      onCommit();
      host.dismiss();
    }, 900);
    return () => clearTimeout(timer);
  }, [onCommit, host.dismiss]);
  // Chiusura: il livello è già identico alla presentazione (o vi si dissolve
  // sopra, arrivando da un capitolo); sotto si torna alla Home (senza
  // animazione nativa), si aspetta che la Home abbia il layout definitivo, si
  // rilegge la cornice reale della card e poi tutto vi rientra — mentre la
  // Home fa rientrare logo e categorie con lo stesso passo.
  const { armHomeSettle, waitHomeSettled, homeCard: homeCardRef, homeReturn: homeReturnRef, clear: hostClear } = host;
  useEffect(() => {
    if (!closing || !measured || started.current) return;
    started.current = true;
    const lead = fadeIn ? FADE_IN_MS : 0;
    if (fadeIn) veil.value = withTiming(1, { duration: FADE_IN_MS, easing: Easing.out(Easing.quad) });
    const slideLead = offsetX !== 0 ? Math.round(SLIDE_BACK_MS * 0.7) : 0;
    let cancelled = false;
    let fadeTimer: ReturnType<typeof setTimeout> | null = null;
    // Il rientro parte solo quando la Home sotto ha finito il suo lavoro (nessuna
    // interazione/transizione in corso e due fotogrammi disegnati): l'animazione
    // non deve mai partire mentre il thread è ancora occupato a montare la Home.
    const start = () => {
      if (cancelled) return;
      InteractionManager.runAfterInteractions(() => requestAnimationFrame(() => requestAnimationFrame(() => {
        if (cancelled) return;
        homeReturnRef.current?.();
        p.value = withTiming(0, { duration: MORPH_DURATION, easing: MORPH_EASING }, (done) => { if (done) runOnJS(hostClear)(); });
        fadeTimer = setTimeout(hostDismiss, MORPH_DURATION - CLOSE_FADE_MS);
      })));
    };
    const commit = setTimeout(async () => {
      if (offsetX !== 0) slideX.value = withTiming(0, { duration: SLIDE_BACK_MS, easing: Easing.out(Easing.cubic) });
      armHomeSettle();
      onCommit();
      await Promise.all([waitHomeSettled(HOME_SETTLE_MAX_MS), new Promise((resolve) => setTimeout(resolve, slideLead))]);
      let fresh: MorphRect | null = null;
      try { fresh = (await homeCardRef.current?.()) ?? null; } catch { fresh = null; }
      if (cancelled) return;
      if (fresh && fresh.width > 0 && fresh.height > 0 && !sameRect(fresh, fromProp)) {
        // Nuova meta: si applica a livello fermo (p = 1, nessun elemento dipende
        // ancora dalla cornice) e si parte quando è stata disegnata.
        setFrom(fresh);
      }
      start();
    }, lead);
    const safety = setTimeout(hostClear, lead + SLIDE_BACK_MS + HOME_SETTLE_MAX_MS + MORPH_DURATION + 1500);
    return () => { cancelled = true; clearTimeout(commit); clearTimeout(safety); if (fadeTimer) clearTimeout(fadeTimer); };
  }, [closing, measured, fadeIn, offsetX, onCommit, p, veil, slideX, fromProp, armHomeSettle, waitHomeSettled, homeCardRef, homeReturnRef, hostClear, hostDismiss]);
  // In chiusura titolo e griglia restano quelli della scheda finché non si sa
  // dove stanno: poi, nello stesso istante, passano agli elementi in movimento.
  const floatingReady = !closing || measured;

  const veilStyle = useAnimatedStyle(() => ({ opacity: veil.value }));
  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: slideX.value }] }));
  const bgStyle = useAnimatedStyle(() => ({ opacity: interpolate(p.value, [0, 0.55], [0, 1], CLAMP) }));
  // Copertina: cornice del lettore che, all'inizio, è schiacciata e spostata
  // sulla card; l'immagine dentro è contro-scalata (mai deformata) e copre sempre il ritaglio.
  const coverStyle = useAnimatedStyle(() => {
    const sx = lerp(p.value, coverScale.x, 1);
    const sy = lerp(p.value, coverScale.y, 1);
    return {
      borderRadius: lerp(p.value, CARD_RADIUS, cover.radius),
      transform: [{ translateX: coverShift.x * (1 - p.value) }, { translateY: coverShift.y * (1 - p.value) }, { scaleX: sx }, { scaleY: sy }],
    };
  });
  const coverImageStyle = useAnimatedStyle(() => {
    const sx = lerp(p.value, coverScale.x, 1);
    const sy = lerp(p.value, coverScale.y, 1);
    const u = Math.max(sx, sy);
    return { transform: [{ scaleX: u / sx }, { scaleY: u / sy }] };
  });
  const homeSkin = useAnimatedStyle(() => ({ opacity: interpolate(p.value, [0, 0.5], [1, 0], CLAMP) }));
  const readerSkin = useAnimatedStyle(() => ({ opacity: interpolate(p.value, [0.25, 0.75], [0, 1], CLAMP) }));
  const titleMove = useAnimatedStyle(() => ({
    transform: [{ translateX: titleShift.x * (1 - p.value) }, { translateY: titleShift.y * (1 - p.value) }],
  }));
  const cardTitleFade = useAnimatedStyle(() => ({ opacity: interpolate(p.value, [0.05, 0.45], [1, 0], CLAMP) }));
  const readerTitleFade = useAnimatedStyle(() => ({ opacity: interpolate(p.value, [0.4, 0.85], [0, 1], CLAMP) }));
  const gridMove = useAnimatedStyle(() => ({
    transform: [{ translateX: gridShift.x * (1 - p.value) }, { translateY: gridShift.y * (1 - p.value) }],
  }));
  const chipsFade = useAnimatedStyle(() => ({ opacity: interpolate(p.value, [0.1, 0.5], [1, 0], CLAMP) }));
  const gridFade = useAnimatedStyle(() => ({
    opacity: interpolate(p.value, [0.45, 0.9], [0, 1], CLAMP),
    transform: [{ scale: interpolate(p.value, [0.3, 1], [0.9, 1], CLAMP) }],
  }));
  const partsStyle = useAnimatedStyle(() => ({
    opacity: interpolate(p.value, [0.5, 1], [0, 1], CLAMP),
    transform: [{ translateY: interpolate(p.value, [0.5, 1], [22, 0], CLAMP) }],
  }));

  return (
    <Animated.View style={[StyleSheet.absoluteFill, veilStyle]} testID="story-morph"
      onLayout={(e) => { const h = Math.round(e.nativeEvent.layout.height); if (h > 0 && h !== layerH && !started.current) setLayerH(h); }}>
      {layerH == null ? null : <>
      {/* Fondo del lettore: compare mentre la Home fa spazio. */}
      <Animated.View style={[StyleSheet.absoluteFill, bgStyle]} pointerEvents="none">
        <ReaderAtmosphere animated={false} />
      </Animated.View>
      {/* Raccordo sotto la copertina, identico al lettore: compare con la pelle "lettura". */}
      <Animated.View style={[StyleSheet.absoluteFill, readerSkin]} pointerEvents="none"><CoverSeam top={cover.height} /></Animated.View>

      {/* Tutto ciò che "è" la schermata (scheda, copertina, titolo, badge) può
          arrivare spostato da uno swipe e rientra al suo posto durante il ritorno. */}
      <Animated.View style={[StyleSheet.absoluteFill, slide]}>
      {/* Apertura identica al lettore: titolo e riga info sono segnaposto invisibili. */}
      <View style={[styles.page, { width: winW, height: winH, paddingTop: coverTop }]} pointerEvents="none">
        <ReaderIntro story={story} coverH={cover.reserve} minHeight={winH - coverTop} bottomInset={insets.bottom} reveal={still} prefix="story-morph"
          ghost={floatingReady} partsStyle={partsStyle}
          onLayout={() => setSheetMeasured(true)} onFit={setReserveCap} remeasure={cardH} onTitleRect={acceptTitle} onGridRect={acceptGrid} />
      </View>

      {/* Copertina: ferma al suo posto, cresce fino alla cornice del lettore (a tutta larghezza). */}
      <Animated.View style={[styles.cover, { left: to.x, top: to.y, width: to.width, height: to.height }, coverStyle]} testID="story-morph-cover">
        <Animated.View style={[StyleSheet.absoluteFill, coverImageStyle]}>
          <StoryHero story={story} style={StyleSheet.absoluteFill} iconSize={64} transition={0} />
          {/* Pelle "lettura": tinta notte e dissolvenza in basso nell'atmosfera, come nel lettore. */}
          <Animated.View style={[StyleSheet.absoluteFill, readerSkin]}><CoverNightSkin /></Animated.View>
        </Animated.View>
        <Animated.View style={[StyleSheet.absoluteFill, homeSkin]}>
          <LinearGradient colors={[withAlpha(colors.artworkSurface, 0), withAlpha(colors.artworkSurface, 0.1), withAlpha(colors.artworkSurface, 0.86), withAlpha(colors.artworkSurface, 0.97)]}
            locations={[0, 0.42, 0.74, 1]} style={StyleSheet.absoluteFill} />
        </Animated.View>
        <Animated.View style={[StyleSheet.absoluteFill, styles.homeEdge, homeSkin]} />
      </Animated.View>
      {premium ? (
        <Animated.View style={[styles.listen, { left: from.x + from.width - inset - 44, top: titleRowBottom - 44 }, homeSkin]} pointerEvents="none">
          <Ionicons name="headset-outline" size={19} color={colors.cyan} />
        </Animated.View>
      ) : null}

      {/* Titolo: dal fondo della card a sotto la copertina (dissolvenza tra i due corpi). */}
      <Animated.View style={[styles.floating, { left: titleAt.x, top: titleAt.y }, !floatingReady && styles.hidden, titleMove]} testID="story-morph-title">
        <Animated.View style={[{ width: titleW }, cardTitleFade]} onLayout={(e) => { const h = e.nativeEvent.layout.height; if (h > 0 && h !== cardTitleH) setCardTitleH(h); }}>
          <HighlightedTitle title={story.title} highlight={story.highlight_words} style={[styles.cardTitle, { fontSize: cardFont, lineHeight: cardFont * 1.14 }]}
            numberOfLines={4} adjustsFontSizeToFit minimumFontScale={0.8} />
        </Animated.View>
        {titleTo ? (
          <Animated.View style={[styles.floating, { left: 0, top: 0, width: titleTo.width }, readerTitleFade]}>
            <CoverTitle title={story.title} highlight={story.highlight_words} reveal={still} testID="story-morph-cover-title" />
          </Animated.View>
        ) : null}
      </Animated.View>

      {/* Dati: il vetro della Home scende (centro su centro) e diventa la scheda del lettore. */}
      <Animated.View style={[styles.floating, { left: gridBox.x, top: gridBox.y, width: gridBox.width, height: gridBox.height }, !floatingReady && styles.hidden, gridMove]} testID="story-morph-badges">
        <Animated.View style={[StyleSheet.absoluteFill, styles.centered, chipsFade]}>
          <View style={{ width: chipsFrom.width }}>
            <StoryInfoGrid story={story} minutes={story.reading_time_min} inline testID="story-morph-home-grid" />
          </View>
        </Animated.View>
        <Animated.View style={[StyleSheet.absoluteFill, gridFade]}>
          <StoryInfoGrid story={story} minutes={story.deep_dive_time_min} inline testID="story-morph-grid" />
        </Animated.View>
      </Animated.View>
      </Animated.View>
      {/* Cornice luminosa del lettore: compare con il fondo. */}
      <Animated.View style={[StyleSheet.absoluteFill, bgStyle]} pointerEvents="none"><ReaderFrame /></Animated.View>
      </>}
    </Animated.View>
  );
}

const useStyles = makeStyles((colors) => ({
  page: { position: "absolute", left: 0, top: 0 },
  floating: { position: "absolute" },
  hidden: { opacity: 0 },
  centered: { alignItems: "center", justifyContent: "center" },
  cover: { position: "absolute", overflow: "hidden", backgroundColor: colors.surfaceSecondary },
  homeEdge: { borderWidth: 1, borderColor: withAlpha(colors.brand, 0.42) },
  listen: {
    position: "absolute", width: 44, height: 44, borderRadius: 24,
    borderWidth: 1, borderColor: colors.glassBorderStrong, backgroundColor: colors.scrim, alignItems: "center", justifyContent: "center",
  },
  cardTitle: {
    color: colors.onGradient, fontFamily: typography.displayBold, letterSpacing: -0.6,
    textShadowColor: withAlpha(colors.artworkSurface, 0.85), textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 6,
  },
}));
