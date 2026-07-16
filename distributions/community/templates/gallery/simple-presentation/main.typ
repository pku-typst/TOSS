#set page(
  width: 13.333in,
  height: 7.5in,
  margin: (x: 0.72in, y: 0.55in),
  fill: white,
)
#set text(size: 22pt, fill: rgb("18211f"))

#let slide(title, body) = {
  pagebreak(weak: true)
  text(12pt, fill: rgb("008f7a"), weight: "bold")[TYPST COLLABORATION]
  v(0.22in)
  text(32pt, weight: "bold")[#title]
  v(0.22in)
  line(length: 100%, stroke: 2pt + rgb("008f7a"))
  v(0.35in)
  body
}

#slide([Presentation title])[
  #text(20pt, fill: luma(85))[Subtitle · Author · Date]
  #v(1fr)
  #text(16pt, fill: luma(100))[Edit together and keep the story focused.]
]

#slide([Three ideas])[
  - Lead with the outcome.
  - Use one visual idea per slide.
  - End with a concrete next step.
]

#slide([Thank you])[
  Questions and discussion
]
