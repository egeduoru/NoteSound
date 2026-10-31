"""Reproducibly compose NoteSound's eight original test pieces. Requires NumPy.

No external recordings, MIDI, samples, or copyrighted melodies are used.
Run from repository root: python scripts/generate-originals.py
The generated recordings and SVG artwork are dedicated to CC0.
"""
from pathlib import Path
import math
import wave
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
RATE = 22050
DURATION = 48
PI = np.pi
NAMES = ["violet-hour", "night-drive", "slow-orbit", "glass-garden", "afterglow", "moonwater", "parallel", "first-light"]
ROOTS = [57, 50, 53, 60, 55, 48, 52, 62]
TEMPOS = [80, 100, 72, 84, 112, 76, 104, 88]
PALETTES = [('#14052f','#b575ff','#4b24cf'),('#031c2c','#42e0ef','#1278ae'),('#142536','#e4bd99','#5c8b9d'),('#102a24','#b9e2a3','#56885c'),('#381227','#f4b494','#b54371'),('#102544','#b6c9f3','#4d5ea4'),('#31162d','#e3a2ed','#8d467b'),('#251b30','#e4c9a2','#ac766f')]

def frequency(midi):
    return 440 * 2 ** ((midi-69)/12)

def compose(index):
    rng = np.random.default_rng(8130 + index)
    samples = np.zeros(RATE * DURATION, dtype=np.float64)
    beat = 60 / TEMPOS[index]
    root = ROOTS[index]
    progression = [0, -5, -2, -7] if index % 2 == 0 else [0, -3, 2, -5]
    def add(start, length, tone, gain=1):
        offset = round(start*RATE)
        size = min(len(samples)-offset, round(length*RATE))
        if offset < 0 or size <= 0: return
        times = np.arange(size) / RATE
        samples[offset:offset+size] += gain * tone(times)

    def pad(t, note, duration):
        envelope = np.minimum(t/0.65, 1) * np.minimum((duration-t)/1.2, 1)
        signal = sum(np.sin(2*PI*frequency(note+pitch)*t + 0.03*np.sin(2*PI*0.3*t)) + .22*np.sin(2*PI*frequency(note+pitch)*2.003*t) for pitch in [0,3,7,10]) / 4
        return signal * np.clip(envelope,0,1) * .12

    for bar in range(math.ceil(DURATION / (beat*4))):
        start = bar * beat*4
        note = root + progression[(bar//2)%4]
        add(start, beat*4.8, lambda t, n=note: pad(t,n,beat*4.8))
        for pulse in range(4):
            at = start + pulse*beat
            # Warm kick with a soft sine pitch envelope.
            if pulse in ([0,2] if index in [2,3,5,7] else [0,1,2,3]):
                add(at, .3, lambda t: .23*np.sin(2*PI*(47*t + 3.8*(1-np.exp(-35*t)))) * np.exp(-t*17))
            if pulse in [1,3] and index not in [3,5]:
                add(at, .15, lambda t: rng.normal(0,1,len(t))*.035*np.exp(-t*27))
            add(at+.5*beat, .07, lambda t: (rng.normal(0,1,len(t)) - np.roll(rng.normal(0,1,len(t)), 1)) * .008*np.exp(-t*75))
            add(at, beat*.92, lambda t,n=note-12: (.12*np.sin(2*PI*frequency(n)*t) + .02*np.sin(2*PI*frequency(n)*2*t))*np.minimum(t/.03,1)*np.exp(-t*2.5))
        # A composed, changing pentatonic arpeggio, offset for each piece.
        motif = [0,7,10,3,7,12,10,7] if index%2==0 else [0,3,7,14,12,7,3,10]
        for step in range(8):
            at = start+step*beat/2
            pitch = note+12+motif[(step+index+bar//4)%8]
            add(at, beat*1.7, lambda t,n=pitch: (.08*np.sin(2*PI*frequency(n)*t)+.018*np.sin(2*PI*frequency(n)*2*t))*np.minimum(t/.012,1)*np.exp(-t*(4.0 if index in [3,5] else 5.5)))
    # Sparse diffuse echoes; no preexisting audio used.
    dry = samples.copy()
    for seconds,gain in [(beat*.75,.22),(beat*1.5,.12),(.047,.08)]:
        delay=round(seconds*RATE)
        samples[delay:] += dry[:-delay]*gain
    timeline=np.arange(len(samples))/RATE
    samples *= np.minimum(timeline/2.5,1)*np.minimum((DURATION-timeline)/4,1)
    samples=np.tanh(samples*1.4)
    samples *= .83/max(.83,np.max(np.abs(samples)))
    path=ROOT/'public'/'audio'/f'{NAMES[index]}.wav'
    path.parent.mkdir(parents=True,exist_ok=True)
    with wave.open(str(path),'wb') as out:
        out.setnchannels(1); out.setsampwidth(2); out.setframerate(RATE)
        out.writeframes((samples*32767).astype('<i2').tobytes())
    print(f'{path.name}: {DURATION}s, {path.stat().st_size:,} bytes')

def cover(index):
    dark,light,accent=PALETTES[index]
    paths=''.join(f'<ellipse cx="256" cy="{290+i*6}" rx="{150-i*2}" ry="{60+i*3}" transform="rotate({-29+index*9} 256 270)" fill="none" stroke="{light}" stroke-opacity="{.1+(16-i)*.025:.3f}" stroke-width="1.3"/>' for i in range(17))
    stars=''.join(f'<circle cx="{(i*83+index*21)%512}" cy="{(i*137+index*47)%512}" r=".7" fill="white" opacity=".22"/>' for i in range(26))
    svg=f'''<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><defs><radialGradient id="bg" cx=".3" cy=".2" r="1"><stop stop-color="{accent}"/><stop offset="1" stop-color="{dark}"/></radialGradient><radialGradient id="sphere" cx=".28" cy=".22"><stop stop-color="{light}"/><stop offset=".36" stop-color="{accent}"/><stop offset="1" stop-color="{dark}"/></radialGradient><filter id="glow"><feGaussianBlur stdDeviation="22"/></filter><linearGradient id="line" x2="1" y2="1"><stop stop-color="{light}" stop-opacity=".8"/><stop offset="1" stop-color="{accent}" stop-opacity="0"/></linearGradient></defs><rect width="512" height="512" fill="url(#bg)"/>{stars}<circle cx="266" cy="237" r="140" fill="{accent}" opacity=".55" filter="url(#glow)"/><circle cx="256" cy="244" r="105" fill="url(#sphere)"/><path d="M-60 367 Q140 115 355 302 T620 197" fill="none" stroke="{light}" stroke-width="9" opacity=".25" filter="url(#glow)"/>{paths}<path d="M-40 410 Q240 110 550 365" fill="none" stroke="url(#line)" stroke-width="1.5"/><text x="35" y="48" font-family="Arial,sans-serif" font-size="10" letter-spacing="4" fill="white" opacity=".65">NOTESOUND ORIGINALS</text><text x="35" y="470" font-family="Arial,sans-serif" font-size="11" letter-spacing="5" fill="{light}" opacity=".8">SESSION 0{index+1}</text></svg>'''
    path=ROOT/'public'/'artwork'/f'{NAMES[index]}.svg'
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(svg,encoding='utf-8')

if __name__=='__main__':
    for index in range(8): compose(index); cover(index)
