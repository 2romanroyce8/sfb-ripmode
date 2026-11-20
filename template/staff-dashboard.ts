export const staffTabs=[
 {key:'dashboard',label:'Home',group:'Daily workspace'},
 {key:'start-here',label:'Start Here',group:'Daily workspace'},
 {key:'my-work',label:'My Work',group:'Daily workspace'},
 {key:'leaderboard',label:'Leaderboard',group:'Daily workspace'},
 {key:'battle-pass',label:'Battle Pass',group:'Daily workspace'},
 {key:'announcements',label:'Announcements',group:'Daily workspace'},
 {key:'check-in',label:'Daily Check-in',group:'Daily workspace'},
 {key:'assignments',label:'Assignments',group:'Daily workspace'},
 {key:'calendar',label:'Calendar',group:'Daily workspace'},
 {key:'notes',label:'Notes',group:'Client work'},
 {key:'contacts',label:'Clients',group:'Client work'},
 {key:'member-success',label:'Member Success',group:'Client work'},
 {key:'dialed-in',label:'Dialed In',group:'Client work'},
 {key:'research',label:'Research',group:'Client work'},
 {key:'analytics',label:'Analytics',group:'Client work'},
 {key:'tools',label:'Tools',group:'Resources & team'},
 {key:'files',label:'Files',group:'Resources & team'},
 {key:'apps',label:'Apps',group:'Resources & team'},
 {key:'team-chat',label:'Team Chat',group:'Resources & team'},
 {key:'team-operations',label:'Team Operations',group:'Resources & team'},
 {key:'team-members',label:'Team Members',group:'Resources & team'},
 {key:'map',label:'Map',group:'Resources & team'},
 {key:'settings',label:'Settings',group:'Resources & team'},
] as const;
export type StaffTabId=typeof staffTabs[number]['key'];
export function canOpenExecutiveDashboard(role:string){return role==='owner'||role==='manager'}


export function visibleStaffTabs(role: string) {
  return staffTabs.filter(tab => tab.key !== 'team-operations' || canOpenExecutiveDashboard(role));
}
