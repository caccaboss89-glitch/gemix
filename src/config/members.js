const ACTIVE_MEMBERS = [
  {
    name: 'Gagliardi Alberto',
    nicks: ['抜刀隊', 'SecondoAccount89'],
    email: 'albertogagliardi08@gmail.com',
    wa: '393922348132@c.us',
    admin: true,
  },
  {
    name: 'Passante Lorenzo',
    nicks: ['lorenzo419', 'Blanc_et_Noir08'],
    email: 'passante.lorenzo.00@gmail.com',
    wa: '393518682781@c.us',
  },
  {
    name: 'Ceraj Gabriel',
    nicks: ['TEDESCODURO'],
    email: 'g.ceraj08@gmail.com',
    wa: '4917672773104@c.us',
  },
  {
    name: 'Fabiano Christian Nicola',
    nicks: ['niky09'],
    email: 'nicola.fabiano2009@gmail.com',
    wa: '393669729298@c.us',
  },
  {
    name: 'Biclea Alexandru Antonio',
    nicks: ['Lil Alex', 'Lil_NGA'],
    email: 'alexbicleajr@gmail.com',
    wa: '393278547055@c.us',
  },
];

function findMemberByWa(jid) {
  const phone = jid.split('@')[0].split(':')[0];
  return ACTIVE_MEMBERS.find(m => m.wa.split('@')[0] === phone) || null;
}

function findMemberByDiscord(username, displayName, nickname) {
  const candidates = [username, displayName, nickname].filter(Boolean).map(n => n.toLowerCase());
  return ACTIVE_MEMBERS.find(m =>
    m.nicks.some(nick => candidates.includes(nick.toLowerCase()))
  ) || null;
}

function findMemberByName(name) {
  if (!name) return null;
  const lower = name.toLowerCase().trim();
  return ACTIVE_MEMBERS.find(m => m.name.toLowerCase() === lower) || null;
}

function isMemberActive(member) {
  return member !== null;
}

function isAdmin(member) {
  return member !== null && member.admin === true;
}

module.exports = { ACTIVE_MEMBERS, findMemberByWa, findMemberByDiscord, findMemberByName, isMemberActive, isAdmin };
