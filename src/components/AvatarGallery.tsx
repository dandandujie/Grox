import { Mascot } from "@/components/Mascot";
import { generateAvatar } from "@/lib/pixel-avatar";

const SEEDS = [
  "Brody", "GitScout", "Emaily", "Omiii", "Onyx", "Ada", "Grace", "Linus",
  "Katherine", "Alan", "Margaret", "Dennis", "Barbara", "Edsger", "Radia", "Ken",
  "Bjarne", "Guido", "James", "Anita", "Shafi", "Frances", "Hedy", "Mary",
];

export function AvatarGallery() {
  return (
    <div className="avatar-gallery">
      <header className="avatar-gallery-head">
        <div>
          <h2>Generated portraits</h2>
          <p>32 x 32, two colors, layered base / hair / eyes / facial hair. The seed is the bot name.</p>
        </div>
        <a href="/" className="btn btn-secondary">Back to Grox</a>
      </header>
      <div className="avatar-gallery-grid">
        {SEEDS.map((seed) => {
          const avatar = generateAvatar(seed);
          return (
            <article key={seed} className="avatar-gallery-card">
              <Mascot seed={seed} title={seed} size={112} />
              <div className="avatar-gallery-name">{seed}</div>
              <div className="avatar-gallery-layer">{avatar.hair.name}</div>
              <div className="avatar-gallery-layer">{avatar.eyes.name}</div>
              <div className="avatar-gallery-layer">{avatar.facial.name}</div>
            </article>
          );
        })}
      </div>
      <footer className="avatar-gallery-foot">
        Every pixel is #000000 or #FFFFFF. The circular background is rasterized on the same 32 x 32 grid.
      </footer>
    </div>
  );
}
