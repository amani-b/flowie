"""
Inference-only model module for the Flowie try-off Space.

Architecture vendored from rizavelioglu/tryoffdiff
(tryoffdiff/modeling/model.py — TryOffDiffv2Multi: SD1.4 UNet with 3-class
embedding + SigLIP-to-cross-attention adapter), restructured to match the
upstream *Space's* inference layout: the frozen SigLIP encoder lives OUTSIDE
this module (loaded once in app.py) and conditioning enters forward() as a
precomputed embedding. That is exactly what the published
`tryoffdiffv2_multi.pth` checkpoint contains (unet + proj + norm — no
encoder weights), so strict loading works.

Upstream license: SSPL (academic/research use — see README.md license
notice). Original authors: Velioglu, Bevandic, Chan, Hammer (BMVC'25,
ICCVW'25). Do not remove this header.
"""

from typing import Any

from diffusers import UNet2DConditionModel
import torch
from torch import nn


class TryOffDiffv2Multi(nn.Module):
    """MGT multi-garment UNet. forward() takes a PRECOMPUTED SigLIP
    embedding [B, 1024, 768] (see app.py _prep) + class labels."""

    def __init__(self):
        super().__init__()
        self.unet = UNet2DConditionModel(
            sample_size=64,
            in_channels=4,
            out_channels=4,
            layers_per_block=2,
            block_out_channels=(320, 640, 1280, 1280),
            down_block_types=(
                "CrossAttnDownBlock2D",
                "CrossAttnDownBlock2D",
                "CrossAttnDownBlock2D",
                "DownBlock2D",
            ),
            up_block_types=(
                "UpBlock2D",
                "CrossAttnUpBlock2D",
                "CrossAttnUpBlock2D",
                "CrossAttnUpBlock2D",
            ),
            cross_attention_dim=768,
            class_embed_type=None,
            num_class_embeds=3,
        )
        # Same init as upstream training module: seed compatible blocks
        # from SD1.4, skipping the class-embedding keys.
        pretrained_state_dict = UNet2DConditionModel.from_pretrained(
            "CompVis/stable-diffusion-v1-4", subfolder="unet"
        ).state_dict()
        self.unet.load_state_dict(pretrained_state_dict, strict=False)
        self.proj = nn.Linear(1024, 77)
        self.norm = nn.LayerNorm(768)

    def forward(self, noisy_latents, t, cond_emb, class_labels):
        cond_emb = self.proj(cond_emb.transpose(1, 2))
        cond_emb = self.norm(cond_emb.transpose(1, 2))
        return self.unet(
            noisy_latents, t, encoder_hidden_states=cond_emb, class_labels=class_labels
        ).sample


# Space-facing alias (app.py addresses the MGT checkpoint as "TryOffDiffv2").
TryOffDiffv2 = TryOffDiffv2Multi


def create_model(model_name: str, **kwargs: Any) -> Any:
    if model_name == "TryOffDiffv2":
        return TryOffDiffv2(**kwargs)
    if model_name == "TryOffDiffv2Multi":
        return TryOffDiffv2Multi(**kwargs)
    raise ValueError(f"unknown model: {model_name}")
