import embeddedScene from './embeddedScene.json';

/**
 * ORDER 60 lifecycle glue around the authored vanilla design.
 * Shaders, scene bytes, motion constants and callback bodies retain the design source.
 * @param {HTMLElement} root
 * @param {{signIn: (email: string, password: string) => Promise<{error?: string, needsVerification?: boolean}>, signUp: (email: string, password: string) => Promise<{error?: string, success?: boolean}>, resetPassword: (email: string) => Promise<{error?: string, success: boolean}>, google: () => Promise<void>, showVerification: (email: string) => void}} handlers
 */
export function mountLanding(root, handlers) {
  let disposed = false, authEpoch = 0;
  const cleanups = [];
  const previousTitle = document.title;
  let landingTitle = 'DropSync';
  function setTitle(title) { landingTitle = title; document.title = title; }
  const titleObserver = new MutationObserver(() => {
    if (!disposed && document.title !== landingTitle) document.title = landingTitle;
  });
  titleObserver.observe(document.head, {childList:true, subtree:true, characterData:true});
  cleanups.push(() => titleObserver.disconnect());
  function listen(target, type, callback, options) {
    target.addEventListener(type, callback, options);
    cleanups.push(() => target.removeEventListener(type, callback, options));
  }
  function observe(observer) { cleanups.push(() => observer.disconnect()); return observer; }
  root.dataset.view = 'b';
  delete root.dataset.transition;
  root.querySelector('.content').inert = root.querySelector('#backToLanding').inert = root.querySelector('.site-links').inert = false;
  root.querySelector('#artCanvas').hidden = false;
  root.querySelector('#fallbackArt').hidden = true;
  setTitle('DropSync');
// The design preview hook is replaced by the real useAuth callbacks supplied by Landing.
const el = id => root.querySelector('#'+id);
let mode = 'signin';
let busy = false;
function setMode(next) {
  if (busy) return;
  mode = next;
  const signup = mode === 'signup', reset = mode === 'reset';
  const lines = reset ? ['A fresh start.', 'Right this way.'] : signup ? ['Make room', 'for your ideas.'] : ['Good to have', 'you back.'];
  el('authTitle').replaceChildren(document.createTextNode(lines[0]), document.createElement('br'), document.createTextNode(lines[1]));
  el('authSub').textContent = reset ? 'Enter your email to receive a reset link.' : signup ? 'A space for your files, links, and ideas.' : 'Your things are right where you left them.';
  el('submitLabel').textContent = reset ? 'Send reset link' : signup ? 'Create your account' : 'Sign in to your space';
  el('switchPrompt').textContent = signup || reset ? 'Already have an account?' : 'New to DropSync?';
  el('switchLabel').textContent = signup || reset ? 'Sign in' : 'Create an account';
  el('passwordField').hidden = reset;
  el('password').required = !reset;
  if (signup) el('password').minLength = 8;
  else el('password').removeAttribute('minlength');
  el('password').autocomplete = signup ? 'new-password' : 'current-password';
  el('password').placeholder = signup ? 'Create a password (8+ characters)' : 'Enter your password';
  el('password').value = '';
  el('password').type = 'password';
  el('togglePassword').setAttribute('aria-label','Show password');
  el('togglePassword').setAttribute('aria-pressed','false');
  el('forgotBtn').hidden = signup;
  el('googleBtn').hidden = reset;
  root.querySelector('.divider').hidden = reset;
  el('authStatus').textContent = '';
  el('authStatus').classList.remove('error');
  setTitle((reset ? 'Reset password' : signup ? 'Create an account' : 'Sign in') + ' — DropSync');
}
listen(el('switchBtn'), 'click', () => setMode(mode === 'signin' ? 'signup' : 'signin'));
listen(el('forgotBtn'), 'click', () => { setMode('reset'); el('email').focus(); });
listen(el('togglePassword'), 'click', () => {
  const show = el('password').type === 'password';
  el('password').type = show ? 'text' : 'password';
  el('togglePassword').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  el('togglePassword').setAttribute('aria-pressed', String(show));
});
function cancelAuthUi() {
  authEpoch++;
  busy = false;
  root.querySelectorAll('.auth button').forEach(button => button.disabled = false);
  el('authForm').removeAttribute('aria-busy');
}
async function authenticate(action, data) {
  if (busy || disposed) return;
  const epoch = ++authEpoch;
  const status = el('authStatus');
  status.classList.remove('error');
  status.textContent = '';
  busy = true;
  const label = el('submitLabel').textContent;
  root.querySelectorAll('.auth button').forEach(button => button.disabled = true);
  el('authForm').setAttribute('aria-busy','true');
  el('submitLabel').textContent = 'Please wait…';
  try {
    const result = action === 'google' ? await handlers.google()
      : action === 'resetPassword' ? await handlers.resetPassword(data.email)
      : action === 'signUp' ? await handlers.signUp(data.email, data.password)
      : await handlers.signIn(data.email, data.password);
    if (disposed || epoch !== authEpoch) return;
    // Match EditorialAuthModal's error-first branch, including its verification path.
    if (result?.error) throw new Error(result.error);
    if (action === 'signIn' && result?.needsVerification) {
      handlers.showVerification(data.email);
      return;
    }
    // Google returns void even on cancellation. Auth context owns app entry; do not invent success.
    if (action === 'google') return;
    if ((action === 'signUp' || action === 'resetPassword') && !result?.success) return;
    status.textContent = action === 'resetPassword' ? 'If an account exists for this email, a reset link has been sent.' : 'You’re all set. Opening your workspace…';
  } catch {
    if (disposed || epoch !== authEpoch) return;
    status.classList.add('error');
    status.textContent = action === 'resetPassword' ? 'We couldn’t send the reset link. Please try again.' : action === 'signUp' ? 'We couldn’t create your account. Please try again.' : 'We couldn’t sign you in. Check your details and try again.';
  } finally {
    if (!disposed && epoch === authEpoch) {
      busy = false;
      root.querySelectorAll('.auth button').forEach(button => button.disabled = false);
      el('authForm').removeAttribute('aria-busy');
      el('submitLabel').textContent = label;
    }
  }
}
listen(el('authForm'), 'submit', event => {
  event.preventDefault();
  if (!el('authForm').reportValidity()) return;
  const data = {email:el('email').value.trim()};
  if (mode !== 'reset') data.password = el('password').value;
  authenticate(mode === 'reset' ? 'resetPassword' : mode === 'signup' ? 'signUp' : 'signIn',data);
});
listen(el('googleBtn'), 'click', () => authenticate('google'));
setMode('signin');
setTitle('DropSync');
(function () {
  'use strict';
  const body = root;
  const openAuth = root.querySelector('#openAuth');
  const openSignup = root.querySelector('#openSignup');
  const back = root.querySelector('#backToLanding');
  const content = root.querySelector('.content');
  const auth = root.querySelector('.auth');
  const artStage = root.querySelector('.art-stage');
  const pitch = root.querySelector('.pitch-inner');
  const headerNote = root.querySelector('.header-note');
  const siteLinks = root.querySelector('.site-links');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let accountEntry = openAuth, transitioning = false, homeScroll = 0;
  let artExit = 0, artJourney = null, startSculpture = function () {};
  let effects = [], masked = [];
  cleanups.push(clearEffects);
  function setView(view, moveFocus) {
    if (disposed) return;
    if (view !== 'b' && view !== 'account') return;
    body.dataset.view = view;
    if (view === 'b') setTitle('DropSync');
    if (moveFocus) {
      if (view === 'account') root.querySelector('#email').focus({preventScroll: true});
      else accountEntry.focus({preventScroll: true});
    }
  }
  function lockTransition(phase) {
    transitioning = true;
    body.dataset.transition = phase;
    content.inert = back.inert = siteLinks.inert = true;
  }
  function clearEffects() {
    effects.forEach(function (effect) { effect.cancel(); }); effects = [];
    masked.forEach(function (element) { element.classList.remove('transition-mask'); }); masked = [];
  }
  function unlockTransition() {
    clearEffects();
    delete body.dataset.transition;
    content.inert = back.inert = siteLinks.inert = false;
    transitioning = false;
  }
  function animatePart(element, frames, timing, gradient) {
    if (disposed) return Promise.resolve();
    if (gradient) { element.classList.add('transition-mask'); masked.push(element); }
    if (typeof element.animate !== 'function') return Promise.resolve();
    const effect = element.animate(frames, Object.assign({fill: 'both', easing: 'cubic-bezier(.22, 1, .36, 1)'}, timing));
    effects.push(effect);
    return effect.finished.catch(function () {});
  }
  function maskFrame(opacity, transform, position) {
    return {opacity: opacity, transform: transform, maskPosition: position, webkitMaskPosition: position};
  }
  function moveSculpture(from, to, duration) {
    artExit = from;
    artJourney = {from: from, to: to, started: performance.now(), duration: duration};
    startSculpture();
  }
  function departureAt(time) {
    if (!artJourney) return artExit;
    const t = Math.max(0, Math.min(1, (time - artJourney.started) / artJourney.duration));
    const eased = artJourney.to === 1 ? t : 1 - Math.pow(1 - t, 3);
    artExit = artJourney.from + (artJourney.to - artJourney.from) * eased;
    if (t === 1) artJourney = null;
    return artExit;
  }
  async function openAccount(nextMode, trigger) {
    if (transitioning || body.dataset.view === 'account') return;
    accountEntry = trigger; homeScroll = window.scrollY; setMode(nextMode);
    if (motion.matches) {
      artExit = 1; artJourney = null;
      setView('account', false); window.scrollTo(0, 0); setView('account', true); return;
    }
    lockTransition('leaving-home');
    try {
      moveSculpture(0, 1, 980);
      await Promise.all([
        animatePart(pitch, [maskFrame(1, 'none', '0% 50%'), maskFrame(0, 'translate3d(22px, -10px, 0) scale(.985)', '100% 50%')], {duration: 820, easing: 'cubic-bezier(.4, 0, .65, 1)'}, true),
        animatePart(artStage, [maskFrame(1, 'none', '0% 50%'), Object.assign(maskFrame(.94, 'none', '24% 50%'), {offset: .4}), maskFrame(0, 'none', '100% 50%')], {duration: 980, easing: 'linear'}, true),
        animatePart(headerNote, [{opacity: 1}, {opacity: 0}], {duration: 450}),
        animatePart(siteLinks, [{opacity: 1}, {opacity: 0}], {duration: 450})
      ]);
      if (disposed) return;
      auth.style.opacity = '0';
      setView('account', false); window.scrollTo(0, 0); clearEffects();
      body.dataset.transition = 'entering-account';
      await Promise.all([
        animatePart(auth, [{opacity: 0}, {opacity: 1}], {duration: 640}),
        animatePart(auth.querySelector('.card'), [maskFrame(0, 'translate3d(0, 18px, 0) scale(.985)', '100% 50%'), maskFrame(1, 'none', '0% 50%')], {duration: 640}, true),
        animatePart(auth.querySelector('.auth-top'), [{opacity: 0, transform: 'translateY(8px)'}, {opacity: 1, transform: 'none'}], {duration: 460, delay: 70}),
        animatePart(auth.querySelector('.auth-footer'), [{opacity: 0}, {opacity: 1}], {duration: 450, delay: 140}),
        animatePart(back, [{opacity: 0}, {opacity: 1}], {duration: 400, delay: 80})
      ]);
    } finally {
      if (!disposed) {
      setView('account', false); auth.style.opacity = '';
      artExit = 1; artJourney = null;
      unlockTransition(); setView('account', true);
      }
    }
  }
  async function returnHome() {
    if (transitioning || body.dataset.view !== 'account') return;
    cancelAuthUi();
    if (motion.matches) {
      artExit = 0; artJourney = null;
      setView('b', false); window.scrollTo(0, homeScroll); startSculpture(); setView('b', true); return;
    }
    lockTransition('leaving-account');
    try {
      await Promise.all([
        animatePart(auth, [maskFrame(1, 'none', '0% 50%'), maskFrame(0, 'translateY(9px)', '100% 50%')], {duration: 320}, true),
        animatePart(back, [{opacity: 1}, {opacity: 0}], {duration: 250})
      ]);
      if (disposed) return;
      setView('b', false); window.scrollTo(0, homeScroll); clearEffects();
      body.dataset.transition = 'entering-home';
      moveSculpture(1, 0, 860);
      await Promise.all([
        animatePart(artStage, [maskFrame(0, 'none', '100% 50%'), maskFrame(1, 'none', '0% 50%')], {duration: 860}, true),
        animatePart(pitch, [maskFrame(0, 'translate3d(-10px, 8px, 0)', '100% 50%'), maskFrame(1, 'none', '0% 50%')], {duration: 680, delay: 140}, true),
        animatePart(headerNote, [{opacity: 0}, {opacity: 1}], {duration: 450, delay: 180}),
        animatePart(siteLinks, [{opacity: 0}, {opacity: 1}], {duration: 450, delay: 180})
      ]);
    } finally {
      if (!disposed) {
      artExit = 0; artJourney = null;
      setView('b', false); unlockTransition(); startSculpture(); setView('b', true);
      }
    }
  }
  listen(openAuth, 'click', function () { openAccount('signin', openAuth); });
  listen(openSignup, 'click', function () { openAccount('signup', openSignup); });
  listen(back, 'click', returnHome);

  // Self-contained WebGL sculpture. Meshes and light visibility are authored in
  // Blender; surfaces, reflections and refracted scene color are rendered live.
  // embeddedScene is imported verbatim from design line 569.
  const canvas = root.querySelector('#artCanvas');
  const fallback = root.querySelector('#fallbackArt');
  const stage = root.querySelector('.art-stage');
  const interactionArea = root.querySelector('.art-column');
  const gl = canvas.getContext('webgl', {alpha:true,antialias:true,depth:true,premultipliedAlpha:true,powerPreference:'low-power'});
  if (!gl) { canvas.hidden=true; fallback.hidden=false; document.dispatchEvent(new Event('dropsync:scene-ready')); return; }
  function retain(resource, method) { cleanups.push(() => gl[method](resource)); return resource; }
  const vertexSource = `
    attribute vec3 aPosition, aNormal;
    attribute float aOcclusion, aSoftLight;
    uniform mat4 uModel, uProjection;
    uniform vec3 uMarkOrigin;
    uniform mat3 uMarkBasis;
    uniform vec2 uMarkSize;
    varying vec2 vMarkUV;
    varying float vMarkFront;
    varying vec3 vNormal, vPosition;
    varying float vOcclusion, vSoftLight;
    void main() {
      vPosition=aPosition;
      vec3 markPosition=uMarkBasis*(aPosition-uMarkOrigin);
      vMarkUV=markPosition.xy/uMarkSize+vec2(.5);
      vMarkFront=(uMarkBasis*aNormal).z;
      vNormal=mat3(uModel)*aNormal;
      vOcclusion=aOcclusion;
      vSoftLight=aSoftLight;
      gl_Position=uProjection*uModel*vec4(aPosition,1.0);
    }`;
  const fragmentSource = `
    precision highp float;
    varying vec2 vMarkUV;
    varying float vMarkFront;
    varying vec3 vNormal, vPosition;
    varying float vOcclusion, vSoftLight;
    uniform vec3 uColor;
    uniform float uRoughness, uMetallic, uOpacity, uEdgeFade;
    uniform vec2 uResolution;
    uniform sampler2D uOpaqueScene;
    uniform sampler2D uMarkTexture;
    uniform float uMarkKind;
    const float PI=3.14159265359;
    float grain(vec3 p) { return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453); }
    vec3 tone(vec3 c) {
      c=(c*(2.51*c+.03))/(c*(2.43*c+.59)+.14);
      return pow(clamp(c,0.0,1.0),vec3(1.0/2.2));
    }
    // An analytic studio environment: large luminous cards and negative fill.
    // Evaluating reflected directions preserves highlights as the mesh turns.
    vec3 studio(vec3 r, float rough) {
      float top=smoothstep(-.75,.8,r.y);
      vec3 c=mix(vec3(.07,.075,.08),vec3(.70,.72,.73),top);
      float softness=.075+rough*.48;
      float key=1.0-smoothstep(.24,.24+softness,length((r.xy-vec2(-.42,.55))*vec2(.8,1.5)));
      float side=1.0-smoothstep(.08,.08+softness,abs(r.x-.76));
      side*=smoothstep(-.8,.5,r.y);
      float strip=1.0-smoothstep(.05,.13+rough*.2,abs(r.x+.72));
      c+=vec3(2.8,2.67,2.48)*key*smoothstep(-.5,.5,r.z);
      c+=vec3(.9,1.02,1.08)*side;
      c+=vec3(.45,.46,.44)*strip;
      c*=1.0-.48*(1.0-smoothstep(.1,.4,abs(r.x-.25)))*(1.0-top);
      return c;
    }
    vec3 direct(vec3 n, vec3 l, vec3 radiance) {
      vec3 v=vec3(0,0,1), h=normalize(v+l);
      float nl=max(dot(n,l),0.0), nv=max(n.z,.001), nh=max(dot(n,h),0.0), vh=max(dot(v,h),0.0);
      float a=uRoughness*uRoughness, a2=a*a;
      float d=a2/(PI*pow(nh*nh*(a2-1.0)+1.0,2.0)+.0001);
      float k=pow(uRoughness+1.0,2.0)/8.0;
      float g=nv/(nv*(1.0-k)+k)*nl/(nl*(1.0-k)+k);
      vec3 f0=mix(vec3(.035),uColor,uMetallic);
      vec3 f=f0+(1.0-f0)*pow(1.0-vh,5.0);
      return ((1.0-f)*(1.0-uMetallic)*uColor/PI+d*g*f/max(4.0*nv*nl,.001))*radiance*nl;
    }
    void main() {
      vec3 n=normalize(vNormal);
      if(!gl_FrontFacing) n=-n;
      float noise=grain(vPosition*850.0)-.5;
      n=normalize(n+vec3(noise,grain(vPosition.yzx*870.0)-.5,0.0)*.006);
      vec3 key=normalize(vec3(-.48,.70,.92));
      // Preserve contact depth under the broad studio fill. The baked field
      // includes the glass tile as a partial occluder, with smooth falloff.
      float contactOcclusion=clamp((1.0-vOcclusion)*2.4,0.0,.78);
      float ao=1.0-contactOcclusion;
      float visibility=.10+.90*vSoftLight;
      float nv=max(n.z,0.0);
      vec3 f0=mix(vec3(.035),uColor,uMetallic);
      vec3 f=f0+(1.0-f0)*pow(1.0-nv,5.0);
      vec3 reflected=studio(reflect(vec3(0,0,-1),n),uRoughness);
      vec3 ambient=mix(vec3(.26,.25,.23),vec3(.44,.43,.41),n.y*.5+.5);
      vec3 c=uColor*ambient*(1.0-uMetallic)*pow(ao,1.65);
      c+=direct(n,key,vec3(3.7,3.58,3.38))*visibility;
      c+=direct(n,normalize(vec3(.7,.18,.75)),vec3(.34,.39,.43))*(.40+.60*ao);
      c+=reflected*f*(.25+.75*ao)*(1.0-uRoughness*.38);
      c=tone(c);
      if(uOpacity>=.99)c*=1.0-.18*contactOcclusion;
      if(uOpacity<.99) {
        // Screen-space transmission samples the opaque geometry rendered this
        // frame, with normal-based bending and a small frosted sampling cone.
        vec2 uv=gl_FragCoord.xy/uResolution;
        float rim=pow(1.0-nv,2.0);
        vec2 offset=-n.xy*(.024+.020*rim);
        vec2 p=clamp(uv+offset,vec2(.002),vec2(.998));
        vec4 under=vec4(0.0);
        for(int i=0;i<16;i++) {
          float a=float(i)*2.39996323;
          float radius=sqrt((float(i)+.5)/16.0)*8.0;
          vec2 sampleUV=clamp(p+vec2(cos(a),sin(a))*radius/uResolution,vec2(.002),vec2(.998));
          under+=texture2D(uOpaqueScene,sampleUV)/16.0;
        }        vec3 background=under.rgb+${document.documentElement.dataset.landingTheme === 'dark' ? 'vec3(.0509804)' : 'vec3(.933333,.925490,.913725)'}*(1.0-under.a);
        background=mix(background,vec3(.86,.89,.90),.45);
        vec3 transmitted=background*mix(vec3(.86,.92,.94),vec3(.50,.64,.70),rim*.65);
        float fresnel=.10+.72*pow(1.0-nv,3.0);
        c=mix(transmitted,tone(reflected*.85),fresnel);
        c+=tone(reflected)*pow(max(dot(n,normalize(vec3(-.48,.70,1.92))),0.0),45.0)*.12;
        c*=1.0-.11*(1.0-ao);
      } else if(uMetallic<.1) {
        c+=noise*.014;
      } else {
        c+=noise*.006;
      }
      // The artwork is sampled in each sheet's original surface coordinates.
      // Marks follow the bow, perspective and independent departure transforms.
      if(uMarkKind>.5 && vMarkFront>.1) {
        vec4 mark=texture2D(uMarkTexture,vMarkUV);
        float face=smoothstep(.1,.6,vMarkFront);
        float coverage=mark.a*face;
        if(uMarkKind>2.5) {
          float shadow=texture2D(uMarkTexture,vMarkUV+vec2(-.009,.011)).a*face*(1.0-mark.a);
          float light=texture2D(uMarkTexture,vMarkUV+vec2(.006,-.007)).a*face*(1.0-mark.a);
          c*=1.0-.14*shadow;
          vec3 enamel=mix(vec3(.73,.84,.87),vec3(.94,.98,.98),.5+.5*max(dot(n,key),0.0));
          c=mix(c,enamel,coverage*.77);
          c+=light*.085;
        } else {
          vec3 ink=clamp(mark.rgb/max(mark.a,.001),0.0,1.0);
          c=mix(c,c*ink,coverage*.52);
        }
      }
      // Feather the physical canvas boundary while the pieces depart or return.
      // The refraction source stays opaque; only the visible pass is softened.
      float edgeAlpha=1.0;
      if(uEdgeFade>.00001) {
        vec2 edgeDistance=min(gl_FragCoord.xy,uResolution-gl_FragCoord.xy)/uResolution;
        float feather=max(.0001,.16*smoothstep(0.0,.18,uEdgeFade));
        edgeAlpha=smoothstep(0.0,feather,edgeDistance.x)*smoothstep(0.0,feather,edgeDistance.y);
      }
      gl_FragColor=vec4(clamp(c,0.0,1.0)*edgeAlpha,edgeAlpha);
    }`;
  function binary(text) {
    const s=atob(text), bytes=new Uint8Array(s.length);
    for(let i=0;i<s.length;i++) bytes[i]=s.charCodeAt(i);
    return bytes.buffer;
  }
  function multiply(a,b) {
    const out=new Float32Array(16);
    for(let c=0;c<4;c++) for(let r=0;r<4;r++) for(let k=0;k<4;k++) out[c*4+r]+=a[k*4+r]*b[c*4+k];
    return out;
  }
  function rotateX(v) {const c=Math.cos(v),s=Math.sin(v);return new Float32Array([1,0,0,0,0,c,s,0,0,-s,c,0,0,0,0,1]);}
  function rotateY(v) {const c=Math.cos(v),s=Math.sin(v);return new Float32Array([c,0,-s,0,0,1,0,0,s,0,c,0,0,0,0,1]);}
  function ortho(span,aspect) {return new Float32Array([1/(span*aspect),0,0,0,0,1/span,0,0,0,0,-.1,0,0,0,0,1]);}
  function rotateZ(v) {const c=Math.cos(v),s=Math.sin(v);return new Float32Array([c,s,0,0,-s,c,0,0,0,0,1,0,0,0,0,1]);}
  const departures = [
    {center:[0,.18,-.4], delay:.07, shift:[-3.9,1.9,-.8], turn:[.18,-.55,.22]},
    {center:[0,.18,-.4], delay:.07, shift:[-3.9,1.9,-.8], turn:[.18,-.55,.22]},
    {center:[-.5457,.8043,.5929], delay:0, shift:[-4.5,2.6,-1.3], turn:[-.2,-.5,.22]},
    {center:[.1843,-.527,1.2604], delay:.11, shift:[-4.4,1.4,-.7], turn:[.15,.5,-.18]},
    {center:[1.1669,-.4342,1.7439], delay:.18, shift:[-3.9,2.3,-.2], turn:[-.18,-.7,.3]}
  ];
  function departingModel(base, pose, progress) {
    if (progress <= pose.delay) return base;
    const t = Math.min(1, (progress - pose.delay) / (1 - pose.delay));
    const pull = t * t * (.4 + .6 * t);
    const local = multiply(rotateZ(pose.turn[2]*pull), multiply(rotateY(pose.turn[1]*pull), rotateX(pose.turn[0]*pull)));
    const scale = 1 - .14 * pull;
    for(let column=0;column<3;column++)for(let row=0;row<3;row++)local[column*4+row]*=scale;
    const c=pose.center, shift=pose.shift;
    local[12]=c[0]+shift[0]*pull-(local[0]*c[0]+local[4]*c[1]+local[8]*c[2]);
    local[13]=c[1]+shift[1]*pull+Math.sin(t*Math.PI)*.16-(local[1]*c[0]+local[5]*c[1]+local[9]*c[2]);
    local[14]=c[2]+shift[2]*pull-(local[2]*c[0]+local[6]*c[1]+local[10]*c[2]);
    return multiply(base,local);
  }
  const surfaceMarks = [null, null,
    {kind:1, origin:[-.58,.86,.65], rotation:[.08,-.22,.31], size:[1.43,2.10]},
    {kind:2, origin:[.22,-.52,1.40], rotation:[-.10,.17,-.28], size:[1.48,2.16]},
    null
  ];
  function markArtwork(surface) {
    const image=document.createElement('canvas');
    image.width=image.height=surface?1024:1;
    if(!surface)return image;
    const ctx=image.getContext('2d');
    const size=surface.size;
    ctx.setTransform(1024/size[0],0,0,-1024/size[1],512,512);
    ctx.lineCap='round';ctx.lineJoin='round';
    function icon(path,x,y,scale,color,width) {
      ctx.save();ctx.translate(x,y);ctx.scale(scale,-scale);ctx.translate(-12,-12);
      ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke(new Path2D(path));ctx.restore();
    }
    function line(x0,x1,y) {
      ctx.beginPath();ctx.moveTo(x0,y);ctx.lineTo(x1,y);ctx.stroke();
    }
    if(surface.kind===1) {
      icon('M6 3.5h8l4 4v12a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19.5v-14A2 2 0 0 1 6 3.5Z M14 3.5v4h4',-.07,.36,.018,'#9eafb4',1.7);
      ctx.strokeStyle='#b9bbb7';ctx.lineWidth=.027;
      line(-.31,.31,-.035);line(-.31,.15,-.195);
    } else if(surface.kind===2) {
      ctx.strokeStyle='#b9bbb8';ctx.lineWidth=.029;
      line(-.43,.25,.15);line(-.43,.10,-.01);line(-.43,-.05,-.17);
    } else {
      icon('m9.5 14.5 5-5 M10.5 7.5 12 6a4 4 0 0 1 5.7 5.7l-2.2 2.2a4 4 0 0 1-5.7 0 M13.5 16.5 12 18a4 4 0 0 1-5.7-5.7l2.2-2.2a4 4 0 0 1 5.7 0',0,-.035,.029,'#edf5f5',1.7);
    }
    return image;
  }
  let renderer, scenePainted=false, failed=false, inView=true, raf=0, targetX=0,targetY=0,currentX=0,currentY=0,lastTime=0;
  cleanups.push(() => { failed=true; cancelAnimationFrame(raf); raf=0; });
  function initialize() {
    function compile(type,source) {
      const shader=retain(gl.createShader(type), "deleteShader"); gl.shaderSource(shader,source); gl.compileShader(shader);
      if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader));
      return shader;
    }
    const program=retain(gl.createProgram(), "deleteProgram");
    const vertex=compile(gl.VERTEX_SHADER,vertexSource), fragment=compile(gl.FRAGMENT_SHADER,fragmentSource);
    gl.attachShader(program,vertex); gl.attachShader(program,fragment); gl.linkProgram(program);
    gl.deleteShader(vertex); gl.deleteShader(fragment);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const a=['aPosition','aNormal','aOcclusion','aSoftLight'].map(n=>gl.getAttribLocation(program,n));
    const u={}; ['uModel','uProjection','uColor','uRoughness','uMetallic','uOpacity','uResolution','uOpaqueScene','uEdgeFade','uMarkOrigin','uMarkBasis','uMarkSize','uMarkTexture','uMarkKind'].forEach(n=>u[n]=gl.getUniformLocation(program,n));
    function buffer(target,data) {const b=retain(gl.createBuffer(), "deleteBuffer");gl.bindBuffer(target,b);gl.bufferData(target,data,gl.STATIC_DRAW);return b;}
    function makeSurfaceMark(surface) {
      const texture=retain(gl.createTexture(), "deleteTexture"),image=markArtwork(surface);
      gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
      if(!surface)return {kind:0,texture:texture,origin:[0,0,0],size:[1,1],basis:new Float32Array([1,0,0,0,1,0,0,0,1])};
      const r=surface.rotation,m=multiply(rotateZ(r[2]),multiply(rotateY(r[1]),rotateX(r[0])));
      const basis=new Float32Array([m[0],m[4],m[8],m[1],m[5],m[9],m[2],m[6],m[10]]);
      return Object.assign({texture:texture,basis:basis},surface);
    }
    const emptyMark=makeSurfaceMark(null);
    const objects=embeddedScene.map((p,i)=>({...p,departure:departures[i],poseModel:null,mark:surfaceMarks[i]?makeSurfaceMark(surfaceMarks[i]):emptyMark,vertex:buffer(gl.ARRAY_BUFFER,new Float32Array(binary(p.vertices))),index:buffer(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(binary(p.indices)))}));
    const texture=retain(gl.createTexture(), "deleteTexture"), dummy=retain(gl.createTexture(), "deleteTexture"), fbo=retain(gl.createFramebuffer(), "deleteFramebuffer"), depth=retain(gl.createRenderbuffer(), "deleteRenderbuffer");
    function configureTexture(t) {
      gl.bindTexture(gl.TEXTURE_2D,t);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    }
    configureTexture(dummy);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(4));
    let tw=0,th=0,refractionReady=false;
    function resizeTarget(w,h) {
      if(tw===w&&th===h)return;tw=w;th=h;
      configureTexture(texture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,w,h,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
      gl.bindRenderbuffer(gl.RENDERBUFFER,depth);gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT16,w,h);
      gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,depth);
      refractionReady=gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.bindTexture(gl.TEXTURE_2D,dummy);
    }
    function draw(p) {
      gl.uniformMatrix4fv(u.uModel,false,p.poseModel);
      gl.uniform3fv(u.uMarkOrigin,p.mark.origin);gl.uniformMatrix3fv(u.uMarkBasis,false,p.mark.basis);
      gl.uniform2fv(u.uMarkSize,p.mark.size);gl.uniform1f(u.uMarkKind,p.mark.kind);gl.uniform1i(u.uMarkTexture,1);
      gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,p.mark.texture);gl.activeTexture(gl.TEXTURE0);
      gl.bindBuffer(gl.ARRAY_BUFFER,p.vertex);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,p.index);
      const sizes=[3,3,1,1],offsets=[0,12,24,28];
      for(let i=0;i<4;i++) {gl.enableVertexAttribArray(a[i]);gl.vertexAttribPointer(a[i],sizes[i],gl.FLOAT,false,32,offsets[i]);}
      gl.uniform3fv(u.uColor,p.color);gl.uniform1f(u.uRoughness,p.roughness);gl.uniform1f(u.uMetallic,p.metallic);gl.uniform1f(u.uOpacity,p.opacity);
      gl.drawElements(gl.TRIANGLES,p.count,gl.UNSIGNED_SHORT,0);
    }
    gl.clearColor(0,0,0,0);gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.disable(gl.BLEND);
    return function render(time) {
      const ratio=Math.min(Math.max(devicePixelRatio||1,1.5),2);
      const width=Math.max(1,Math.round(canvas.clientWidth*ratio)),height=Math.max(1,Math.round(canvas.clientHeight*ratio));
      if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
      gl.viewport(0,0,width,height);resizeTarget(width,height);
      gl.uniformMatrix4fv(u.uProjection,false,ortho(2.62,width/height));
      const elapsed=Math.min(50,Math.max(0,time-lastTime));lastTime=time;
      const ease=1-Math.exp(-elapsed/140);
      currentX+=(targetX-currentX)*ease;currentY+=(targetY-currentY)*ease;
      const model=multiply(rotateY(currentY),rotateX(currentX));
      model[12]=.22;model[13]=.32;
      for(const p of objects)p.poseModel=departingModel(model,p.departure,artExit);
      gl.uniformMatrix4fv(u.uModel,false,model);gl.uniform2f(u.uResolution,width,height);gl.uniform1i(u.uOpaqueScene,0);
      gl.uniform1f(u.uEdgeFade,0);
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,dummy);gl.depthMask(true);gl.disable(gl.CULL_FACE);
      if(refractionReady) {
        gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
        for(const p of objects)if(p.opacity>=.99)draw(p);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      gl.uniform1f(u.uEdgeFade,artExit);
      for(const p of objects)if(p.opacity>=.99)draw(p);
      gl.bindTexture(gl.TEXTURE_2D,refractionReady?texture:dummy);
      gl.enable(gl.CULL_FACE);gl.cullFace(gl.BACK);
      for(const p of objects)if(p.opacity<.99)draw(p);
      gl.disable(gl.CULL_FACE);gl.bindTexture(gl.TEXTURE_2D,dummy);
      canvas.dataset.renderer='webgl';canvas.dataset.refraction=String(refractionReady);
    };
  }
  function fail(error) {failed=true;canvas.hidden=true;fallback.hidden=false;document.dispatchEvent(new Event('dropsync:scene-ready'));console.error('Unable to render the sculpture:',error);}
  try {renderer=initialize();} catch(error){fail(error);return;}
  function frame(time) {
    raf=0;
    if(failed||document.hidden||!inView||body.dataset.view==='account')return;
    artExit=departureAt(time);
    stage.style.setProperty('--departure',String(artExit));
    if(artExit>0)targetX=targetY=0;
    if(motion.matches){targetX=targetY=currentX=currentY=0;}
    renderer(time);
    if(!scenePainted) {scenePainted=true;document.dispatchEvent(new Event('dropsync:scene-ready'));}
    if(artJourney||Math.abs(targetX-currentX)+Math.abs(targetY-currentY)>.00005)start();
  }
  function start(){if(!raf&&!failed)raf=requestAnimationFrame(frame);}
  // Follow the pointer across the artwork column, with a bounded 3D turn.
  // Render until the eased pose settles; the scene remains idle afterwards.
  listen(interactionArea, 'pointermove',event=>{
    if(motion.matches||transitioning||body.dataset.view!=='b'||event.pointerType==='touch')return;
    const r=stage.getBoundingClientRect();
    if(!r.width||!r.height)return;
    targetY=Math.max(-.5,Math.min(.5,(event.clientX-r.left)/r.width-.5))*.36;
    targetX=Math.max(-.5,Math.min(.5,(event.clientY-r.top)/r.height-.5))*.24;
    start();
  },{passive:true});
  function resetPointer(){targetX=targetY=0;start();}
  listen(interactionArea, 'pointerleave',resetPointer);
  listen(interactionArea, 'pointercancel',resetPointer);
  listen(window, 'blur',resetPointer);
  if('ResizeObserver' in window)observe(new ResizeObserver(start)).observe(stage);
  if('IntersectionObserver' in window)observe(new IntersectionObserver(entries=>{inView=entries[0].isIntersecting;if(inView)start();})).observe(stage);
  listen(window, 'resize',start);
  listen(document, 'visibilitychange',start);
  listen(back, 'click',start);
  listen(motion, 'change',start);
  listen(canvas, 'webglcontextlost',event=>{event.preventDefault();failed=true;cancelAnimationFrame(raf);raf=0;canvas.hidden=true;fallback.hidden=false;});
  listen(canvas, 'webglcontextrestored',()=>{
    try {renderer=initialize();failed=false;canvas.hidden=false;fallback.hidden=true;start();}catch(error){fail(error);}
  });
  startSculpture=start;
  start();
})();
  return () => {
    if (disposed) return;
    disposed = true;
    authEpoch++;
    for (const cleanup of cleanups.reverse()) cleanup();
    document.title = previousTitle;
  };
}
