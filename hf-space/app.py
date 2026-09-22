"""
Flowie / FitFlow AI — Phase 2/3 img2img Space (Gradio SDK, ZeroGPU).

Model choice: black-forest-labs/FLUX.1-schnell (12B rectified-flow
transformer, adversarially distilled to 1-4 steps), via
diffusers FluxImg2ImgPipeline. NOT SDXL-Turbo anymore: Turbo was fast but
rendered studio light flatter than the 12B FLUX.1-Kontext-dev reference
(Image 1). Schnell is the same FLUX family / same 12B backbone class as
Kontext, so low-strength img2img preserves garment weave, tapes and logos
the way Kontext did — at 4 steps instead of 20-50.

Why schnell for this job:
  - Distilled for the 1-4 step regime (guidance_scale=0.0, like Turbo), so a
    call is ~4 transformer passes, not 20-50. Same speed class as the old
    Space, an order of magnitude faster than full dev/Kontext runs.
  - 16-channel FLUX VAE (vs 4-channel SDXL VAE): encode/decode round-trip
    keeps fine fabric detail and small printed text far better at low
    strengths (0.25-0.45), which is exactly our operating point.
  - img2img rule enforced: num_inference_steps * strength >= 1, else the pipe
    raises (ValueError: steps < 1). Guarded below.

GATED MODEL: FLUX.1-schnell requires accepting the license at
https://huggingface.co/black-forest-labs/FLUX.1-schnell and an HF_TOKEN
Space Secret (Settings -> Secrets) so the build can download weights.
No token in code, ever.

ZeroGPU discipline:
  - Only `generate()` touches the GPU (@spaces.GPU(duration=60)). Model load
    happens once at startup; queue + _prep + _polish stay on CPU (polish is
    free classical PIL: autocontrast/saturation/crisp, zero quota).
  - 768px longest-side (multiples of 16, FLUX requirement) balances fabric
    detail vs per-call seconds. Quota burns per reserved 60 s slot:
    ~5 garments/day free, ~40/day PRO.

API (named endpoint "/predict" — stable for gradio_client / @gradio/client):
  inputs:  input_image (filepath), prompt (str), negative_prompt (str),
           strength (0.0-1.0), num_steps (1-4), seed (int)
  output:  generated image (PIL), polished

NOTE on negative_prompt: schnell runs guidanceless (guidance_scale=0.0), so
the negative prompt is inert on the math — accepted anyway so the Phase 3
harness keeps a stable signature across models.
"""

import math

import gradio as gr
import spaces
import torch
from diffusers import FluxImg2ImgPipeline
from PIL import Image, ImageEnhance, ImageFilter, ImageOps

MODEL_ID = "black-forest-labs/FLUX.1-schnell"
SIZE = 768  # longest side; snapped to multiples of 16 (FLUX requirement)

_pipe = FluxImg2ImgPipeline.from_pretrained(
    MODEL_ID,
    torch_dtype=torch.bfloat16,
).to("cuda")
_pipe.set_progress_bar_config(disable=True)


def _prep(img: Image.Image) -> Image.Image:
    img = img.convert("RGB")
    w, h = img.size
    s = SIZE / max(w, h)
    # FLUX VAE/patch layout needs H, W divisible by 16.
    nw = max(16, round(w * s / 16) * 16)
    nh = max(16, round(h * s / 16) * 16)
    return img.resize((nw, nh), Image.LANCZOS)


@spaces.GPU(duration=60)
def generate(
    input_image,
    prompt: str,
    negative_prompt: str,
    strength: float,
    num_steps: int,
    seed: int = 42,
):
    """Img2img inference. GPU is claimed only inside this function."""
    if input_image is None:
        raise gr.Error("Upload a Phase 1 studio_composite image first.")
    init = _prep(input_image if isinstance(input_image, Image.Image) else Image.open(input_image))

    # Clamp to the 1-4 step schnell regime + the >=1 effective-step rule.
    num_steps = int(max(1, min(4, round(num_steps))))
    strength = float(max(0.05, min(1.0, strength)))
    if int(num_steps * strength) < 1:
        num_steps = int(math.ceil(1.0 / strength))

    generator = torch.Generator(device="cpu").manual_seed(int(seed))
    out = _pipe(
        prompt=prompt or STUDIO_PROMPT,
        # negative_prompt accepted for API stability; inert at guidance 0.0
        # (see module docstring).
        negative_prompt=negative_prompt or "",
        image=init,
        strength=strength,
        num_inference_steps=num_steps,
        guidance_scale=0.0,
        max_sequence_length=256,  # schnell standard; halves T5 encode cost
        generator=generator,
    ).images[0]
    return out


def _polish(img: Image.Image) -> Image.Image:
    """Deterministic classical finish: studio-pop without touching garment hue.

    CPU-only (runs outside @spaces.GPU, so zero quota). Conservative by design:
    criterion (a) same-garment comes first — small global operators only, no
    hue shift, no local edits.
    """
    img = ImageOps.autocontrast(img, cutoff=0.5)  # full tonal range, tiny clip
    img = ImageEnhance.Color(img).enhance(1.06)  # +6% saturation, no hue shift
    img = ImageEnhance.Contrast(img).enhance(1.04)
    return img.filter(ImageFilter.UnsharpMask(radius=2, percent=60, threshold=3))


def enhance(input_image, prompt, negative_prompt, strength, num_steps, seed=42):
    """Public endpoint: GPU inference + free CPU polish. Quota burns only
    inside generate() (60 s slot); _polish costs nothing."""
    return _polish(generate(input_image, prompt, negative_prompt, strength, num_steps, seed))


STUDIO_PROMPT = (
    "professional studio product photography of a garment, soft diffused lighting, "
    "crisp fabric texture, perfectly legible printed text and logos, accurate small "
    "lettering, clean e-commerce catalog shot, photorealistic"
)
STUDIO_NEGATIVE = "person, human, model, mannequin, face, hands, blurry, distorted, extra limbs"

with gr.Blocks(title="Flowie garment img2img (FLUX.1-schnell, ZeroGPU)") as demo:
    gr.Markdown(
        "# Flowie garment img2img — FLUX.1-schnell on ZeroGPU\n"
        "Input = Phase 1 `studio_composite`. Output = same garment, studio re-light. "
        "Strength 0.25-0.45 keeps the garment; higher drifts. 4 steps recommended. "
        "Negative prompt is accepted but inert at guidance 0.0 (schnell design). "
        "Classical polish (contrast/saturation/crisp) is applied free on CPU."
    )
    with gr.Row():
        with gr.Column():
            in_img = gr.Image(type="pil", label="Input garment (Phase 1 composite)")
            prompt = gr.Textbox(value=STUDIO_PROMPT, label="Prompt")
            neg = gr.Textbox(value=STUDIO_NEGATIVE, label="Negative prompt (stored, inert on schnell)")
            with gr.Row():
                strength = gr.Slider(0.05, 1.0, value=0.3, step=0.05, label="Strength")
                steps = gr.Slider(1, 4, value=4, step=1, label="Steps (1-4)")
            seed = gr.Number(value=42, precision=0, label="Seed")
            btn = gr.Button("Enhance", variant="primary")
        with gr.Column():
            out_img = gr.Image(type="pil", label="Studio result")
    btn.click(
        fn=enhance,
        inputs=[in_img, prompt, neg, strength, steps, seed],
        outputs=out_img,
        api_name="predict",
    )
    gr.Examples(
        examples=[[None, STUDIO_PROMPT, STUDIO_NEGATIVE, 0.3, 4, 42]],
        inputs=[in_img, prompt, neg, strength, steps, seed],
    )

if __name__ == "__main__":
    demo.queue().launch()
